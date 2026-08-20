/**
 * 微信 iLink Bot API 实现
 *
 * 基于腾讯官方开放的 iLink Bot 协议
 * 文档：https://ilinkai.weixin.qq.com
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import crypto from 'node:crypto';
import { aesEcbPaddedSize } from './cdn/aes-ecb.js';
import { uploadBufferToCdn } from './cdn/cdn-upload.js';
import { getMimeFromFilename } from './media/mime.js';

/**
 * 微信配置文件结构
 */
export interface WeixinConfigFile {
  /** Bot Token（登录后获得） */
  botToken?: string;
  /** Base URL（可选，用于测试） */
  baseUrl?: string;
  /** 登录时间戳 */
  loginTime?: number;
}

/**
 * 登录二维码响应
 */
export interface QrcodeResponse {
  /** 二维码 ID（用于轮询状态，不是二维码内容） */
  qrcode: string;
  /** 二维码图片（base64） */
  qrcode_img_content?: string;
  /** 二维码 URL（可能是完整的扫码链接） */
  url?: string;
}

/**
 * 扫码状态响应
 */
export interface QrcodeStatusResponse {
  /** 状态：pending/confirmed/expired */
  status: 'pending' | 'confirmed' | 'expired';
  /** Bot Token（确认后返回） */
  bot_token?: string;
  /** Base URL（确认后返回） */
  baseurl?: string;
}

/**
 * 微信消息类型
 */
export enum MessageType {
  USER = 1,      // 用户消息
  BOT = 2,       // Bot 消息
  SYSTEM = 3,    // 系统消息
}

/**
 * 消息状态
 */
export enum MessageState {
  FINISH = 2,    // 完整消息
}

/**
 * 消息 Item 类型
 */
export enum ItemType {
  TEXT = 1,      // 文本
  IMAGE = 2,     // 图片
  VOICE = 3,     // 语音
  FILE = 4,      // 文件
  VIDEO = 5,     // 视频
}

/**
 * 上传时的媒体分类
 */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

/** CDN Base URL for Weixin media upload */
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/**
 * 上传后的文件信息（CDN 引用）
 */
export interface UploadedFileInfo {
  /** 随机生成的 filekey */
  filekey: string;
  /** CDN 下载加密参数 → 填入 image_item.media.encrypt_query_param */
  downloadEncryptedQueryParam: string;
  /** AES-128-ECB key, hex-encoded → 转为 base64 填入 CDNMedia.aes_key */
  aeskey: string;
  /** 明文文件大小 */
  fileSize: number;
  /** 密文文件大小 (AES-128-ECB with PKCS7 padding) */
  fileSizeCiphertext: number;
}

/**
 * 文本 Item
 */
export interface TextItem {
  type: 1;
  text_item: {
    text: string;
  };
}

/**
 * 图片 Item
 */
export interface ImageItem {
  type: 2;
  image_item: {
    aes_key: string;        // base64 编码的 AES key
    cdn_url?: string;       // CDN URL
    width?: number;
    height?: number;
  };
}

/**
 * 消息 Item 联合类型
 */
export type MessageItem = TextItem | ImageItem | Record<string, unknown>;

/**
 * 微信消息
 */
export interface WeixinMessage {
  /** 发送者 ID */
  from_user_id: string;
  /** 接收者 ID */
  to_user_id: string;
  /** 消息类型 */
  message_type: MessageType;
  /** 消息状态 */
  message_state: MessageState;
  /** 上下文 Token（必须原样带回） */
  context_token: string;
  /** 消息内容列表 */
  item_list: MessageItem[];
  /** 群 ID（如果是群消息） */
  group_id?: string;
}

/**
 * GetUpdates 响应
 */
export interface GetUpdatesResponse {
  /** 返回码 */
  ret: number;
  /** 错误码（会话失效等错误时返回，如 -14 session timeout；正常响应不携带） */
  errcode?: number;
  /** 错误信息（随 errcode 返回） */
  errmsg?: string;
  /** 消息列表 */
  msgs?: WeixinMessage[];
  /** 下次请求的游标 */
  get_updates_buf: string;
  /** 长轮询超时时间 */
  longpolling_timeout_ms?: number;
}

/**
 * 发送消息请求
 */
export interface SendMessageRequest {
  /** 发送者 ID（Bot 发送时为空字符串） */
  from_user_id: string;
  /** 接收者 ID */
  to_user_id: string;
  /** 客户端 ID */
  client_id: string;
  /** 消息类型 */
  message_type: MessageType;
  /** 消息状态 */
  message_state: MessageState;
  /** 上下文 Token */
  context_token: string;
  /** 消息内容 */
  item_list: MessageItem[];
}

/**
 * 发送消息响应
 */
export interface SendMessageResponse {
  /** 返回码 */
  ret: number;
  /** 消息 ID */
  msg_id?: string;
}

/**
 * GetConfig 请求
 */
export interface GetConfigRequest {
  /** 用户 ID */
  ilink_user_id: string;
  /** 上下文 Token */
  context_token: string;
  /** 基础信息 */
  base_info: {
    channel_version: string;
  };
}

/**
 * GetConfig 响应
 */
export interface GetConfigResponse {
  /** 返回码 */
  ret: number;
  /** typing ticket */
  typing_ticket?: string;
}

/**
 * SendTyping 请求
 */
export interface SendTypingRequest {
  /** 用户 ID */
  ilink_user_id: string;
  /** typing ticket */
  typing_ticket: string;
  /** 状态：1=正在输入, 2=取消 */
  status: number;
}

/**
 * 微信 API 客户端
 */
export class WeixinApiClient {
  private readonly BASE_URL = 'https://ilinkai.weixin.qq.com';
  private baseUrl: string;
  private botToken: string | null = null;
  private configPath: string;
  private xWechatUin: string | null = null;  // 会话期间保持一致
  private getUpdatesLogged = false;  // getUpdates 请求日志只打印首次

  constructor(configPath?: string) {
    this.configPath = configPath || join(process.cwd(), '.agentdev', 'weixin-bot.config.json');
    this.baseUrl = this.BASE_URL;

    // 尝试从配置文件加载
    this.loadConfig();
  }

  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * 生成随机 X-WECHAT-UIN（会话期间只生成一次）
   */
  private getXWechatUin(): string {
    if (!this.xWechatUin) {
      const randomUint32 = Math.floor(Math.random() * 0xFFFFFFFF);
      const str = randomUint32.toString();
      this.xWechatUin = Buffer.from(str).toString('base64');
      console.log('[WeixinAPI] 生成 X-WECHAT-UIN:', this.xWechatUin);
    }
    return this.xWechatUin;
  }

  /**
   * 构建请求头
   */
  private buildHeaders(needAuth = true): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': this.getXWechatUin(),
    };

    if (needAuth && this.botToken) {
      headers['Authorization'] = `Bearer ${this.botToken}`;
    }

    return headers;
  }

  /**
   * 发起 HTTP 请求
   */
  private async request(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<any> {
    const url = `${this.baseUrl}/${endpoint}`;

    const headers = this.buildHeaders(!endpoint.includes('get_bot_qrcode'));
    const defaultOptions: RequestInit = {
      ...options,
      headers: {
        ...headers,
        ...options.headers,
      },
    };

    // 调试：打印请求详情
    if (endpoint.includes('sendmessage')) {
      console.log('[WeixinAPI] ========== 发送消息请求详情 ==========');
      console.log('[WeixinAPI] 完整 URL:', url);
      console.log('[WeixinAPI] 请求头:', JSON.stringify(headers, null, 2));
      console.log('[WeixinAPI] 请求方法:', defaultOptions.method);
      console.log('[WeixinAPI] =======================================');
    }

    try {
      const response = await fetch(url, defaultOptions);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const responseText = await response.text();
      const responseJson = responseText ? JSON.parse(responseText) : {};

      if (endpoint.includes('sendmessage')) {
        console.log('[WeixinAPI] ========== 发送消息响应详情 ==========');
        console.log('[WeixinAPI] 响应状态:', response.status);
        console.log('[WeixinAPI] 响应头:', JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2));
        console.log('[WeixinAPI] 响应体（原始）:', responseText);
        console.log('[WeixinAPI] 响应体（JSON）:', JSON.stringify(responseJson, null, 2));
        console.log('[WeixinAPI] =======================================');
      }

      return responseJson;
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`请求失败: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * 获取登录二维码
   */
  async getBotQrcode(): Promise<QrcodeResponse> {
    console.log('[WeixinAPI] 正在获取登录二维码...');
    const response = await this.request(`ilink/bot/get_bot_qrcode?bot_type=3`);
    console.log('[WeixinAPI] 二维码获取成功');
    return response;
  }

  /**
   * 生成二维码图片到终端
   */
  async displayQrcode(qrcodeResponse: QrcodeResponse): Promise<void> {
    const { default: open } = await import('open');

    console.log('\n========================================');
    console.log('请使用微信扫描以下二维码登录：');
    console.log('========================================\n');

    const qrcodeImagePath = join(process.cwd(), 'weixin-qrcode.png');

    const qrcodeUrl = WeixinApiClient.resolveQrcodeUrl(qrcodeResponse);
    console.log(`✓ 二维码 URL: ${qrcodeUrl}\n`);

    // 使用 URL 生成二维码图片
    const QRCode = (await import('qrcode')).default;
    try {
      await QRCode.toFile(qrcodeImagePath, qrcodeUrl, {
        width: 300,
        margin: 2,
      });
      console.log(`✓ 二维码图片已保存到: ${qrcodeImagePath}\n`);

      // 在终端显示 ASCII 二维码
      try {
        const asciiQrcode = await QRCode.toString(qrcodeUrl, { type: 'terminal', small: true });
        console.log('----------------------------------------');
        console.log(asciiQrcode);
        console.log('----------------------------------------\n');
      } catch (asciiErr) {
        console.log('[注意] 终端 ASCII 二维码显示失败\n');
      }

      // 自动打开图片
      try {
        await open(qrcodeImagePath);
        console.log('[提示] 已尝试用系统默认程序打开二维码图片\n');
      } catch (openErr) {
        console.log('[提示] 请手动打开二维码图片文件\n');
      }
    } catch (err) {
      console.error('生成二维码失败:', err);
      throw err;
    }

    console.log('[WeixinBot] 等待扫码...\n');
  }

  /**
   * 轮询扫码状态
   */
  async getQrcodeStatus(qrcode: string): Promise<QrcodeStatusResponse> {
    const response = await this.request(
      `ilink/bot/get_qrcode_status?qrcode=${qrcode}`
    );
    return response;
  }

  /**
   * 长轮询获取消息
   */
  async getUpdates(getUpdatesBuf: string, timeout = 35): Promise<GetUpdatesResponse> {
    if (!this.botToken) {
      throw new Error('未登录，请先扫码登录');
    }

    // 只在首次请求时打印日志（不能用游标为空判断：会话失效后游标恒为空，会导致每轮都当作"首次"刷屏）
    const shouldLog = !this.getUpdatesLogged;
    this.getUpdatesLogged = true;

    if (shouldLog) {
      console.log('[WeixinAPI] 发起 getUpdates 请求，游标:', getUpdatesBuf || '(首次)');
    }

    try {
      const response = await this.request('ilink/bot/getupdates', {
        method: 'POST',
        body: JSON.stringify({
          get_updates_buf: getUpdatesBuf,
          base_info: {
            channel_version: '1.0.2',
          },
        }),
      });

      if (shouldLog) {
        console.log('[WeixinAPI] getUpdates 响应:', JSON.stringify(response).slice(0, 200));
      }

      return response;
    } catch (error) {
      console.error('[WeixinAPI] getUpdates 请求失败:', error);
      throw error;
    }
  }

  /**
   * 生成随机 client_id
   */
  private generateClientId(): string {
    const randomHex = Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(8, '0');
    return `openclaw-weixin-${randomHex}`;
  }

  /**
   * 获取配置（获取 typing_ticket）
   */
  async getConfig(ilinkUserId: string, contextToken: string): Promise<GetConfigResponse> {
    if (!this.botToken) {
      throw new Error('未登录，请先扫码登录');
    }

    console.log(`[WeixinAPI] 获取配置，用户: ${ilinkUserId}`);

    const requestBody: GetConfigRequest = {
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
      base_info: {
        channel_version: '1.0.2',
      },
    };

    try {
      const response = await this.request('ilink/bot/getconfig', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      });

      console.log('[WeixinAPI] getconfig 响应:', JSON.stringify(response, null, 2));
      return response;
    } catch (error) {
      console.error('[WeixinAPI] getconfig 请求失败:', error);
      throw error;
    }
  }

  /**
   * 发送正在输入状态
   */
  async sendTyping(ilinkUserId: string, typingTicket: string, status: 1 | 2): Promise<void> {
    if (!this.botToken) {
      throw new Error('未登录，请先扫码登录');
    }

    const requestBody: SendTypingRequest = {
      ilink_user_id: ilinkUserId,
      typing_ticket: typingTicket,
      status,
    };

    try {
      await this.request('ilink/bot/sendtyping', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      console.error('[WeixinAPI] sendtyping 请求失败:', error);
      // 不抛出错误，typing 失败不应阻止消息发送
    }
  }

  /**
   * 发送文本消息
   */
  async sendTextMessage(
    toUserId: string,
    text: string,
    contextToken: string
  ): Promise<SendMessageResponse> {
    if (!this.botToken) {
      throw new Error('未登录，请先扫码登录');
    }

    console.log(`[WeixinAPI] 准备发送消息到 ${toUserId}: "${text.slice(0, 50)}..."`);

    const requestBody = {
      msg: {
        from_user_id: '',  // Bot 发送时必须为空字符串
        to_user_id: toUserId,
        client_id: this.generateClientId(),  // 必须包含
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: contextToken,
        item_list: [
          {
            type: ItemType.TEXT,
            create_time_ms: Date.now(),
            update_time_ms: Date.now(),
            is_completed: true,
            text_item: { text },
          },
        ],
      },
      base_info: {  // 必须包含
        channel_version: '1.0.2',
      },
    };

    console.log('[WeixinAPI] 请求体:', JSON.stringify(requestBody, null, 2));

    try {
      const response = await this.request('ilink/bot/sendmessage', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      });

      console.log('[WeixinAPI] sendmessage API 完整响应:', JSON.stringify(response, null, 2));

      // 检查响应中的 ret 字段（如果存在）
      if ('ret' in response) {
        if (response.ret === 0) {
          console.log('[WeixinAPI] ✓ 消息发送成功 (ret=0)');
        } else {
          console.error('[WeixinAPI] ✗ sendmessage 返回错误码:', response.ret);
          console.error('[WeixinAPI] 错误详情:', JSON.stringify(response, null, 2));
          throw new Error(`发送消息失败，错误码: ${response.ret}`);
        }
      } else {
        // 没有 ret 字段，检查是否有其他错误标志
        console.log('[WeixinAPI] ⚠ 响应中没有 ret 字段，假设成功');
        console.log('[WeixinAPI] ✓ 消息已发送（但未确认）');
      }

      return response;
    } catch (error) {
      console.error('[WeixinAPI] sendmessage 请求异常:', error);
      throw error;
    }
  }

  /**
   * 保存配置到文件
   */
  saveConfig(config: WeixinConfigFile): void {
    const dir = dirname(this.configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    try {
      writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
      console.log(`[WeixinAPI] 配置已保存到 ${this.configPath}`);
    } catch (error) {
      console.error('[WeixinAPI] 保存配置失败:', error);
    }
  }

  /**
   * 从文件加载配置
   */
  loadConfig(): boolean {
    if (!existsSync(this.configPath)) {
      return false;
    }

    try {
      const content = readFileSync(this.configPath, 'utf-8');
      const config = JSON.parse(content) as WeixinConfigFile;

      if (config.botToken) {
        this.botToken = config.botToken;
        console.log('[WeixinAPI] 从配置文件加载了 bot_token');
      }

      if (config.baseUrl) {
        this.baseUrl = config.baseUrl;
      }

      return true;
    } catch (error) {
      console.error('[WeixinAPI] 加载配置失败:', error);
      return false;
    }
  }

  /**
   * 设置 Bot Token 和 Base URL
   */
  setBotToken(token: string, baseUrl?: string): void {
    this.botToken = token;

    // 如果提供了 baseurl，使用它（登录时返回的）
    if (baseUrl) {
      this.baseUrl = baseUrl;
      console.log('[WeixinAPI] ✓ 使用服务器返回的 baseurl:', baseUrl);
    }

    // 保存到配置文件
    const config: WeixinConfigFile = {
      botToken: token,
      baseUrl: this.baseUrl,
      loginTime: Date.now(),
    };
    this.saveConfig(config);
  }

  /**
   * 获取 Bot Token
   */
  getBotToken(): string | null {
    return this.botToken;
  }

  getPersistedConfig(): WeixinConfigFile {
    if (!existsSync(this.configPath)) {
      return {};
    }

    try {
      const content = readFileSync(this.configPath, 'utf-8');
      const config = JSON.parse(content) as WeixinConfigFile;
      return config && typeof config === 'object' ? config : {};
    } catch (error) {
      console.error('[WeixinAPI] 读取配置失败:', error);
      return {};
    }
  }

  /**
   * 检查是否已登录
   */
  isLoggedIn(): boolean {
    return !!this.botToken;
  }

  /**
   * 清除登录状态
   */
  clearToken(): void {
    this.botToken = null;

    try {
      if (existsSync(this.configPath)) {
        const config = JSON.parse(readFileSync(this.configPath, 'utf-8'));
        delete config.botToken;
        delete config.loginTime;
        writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
        console.log('[WeixinAPI] 已清除登录状态');
      }
    } catch (error) {
      console.error('[WeixinAPI] 清除登录状态失败:', error);
    }
  }

  // ========== 媒体上传 & 发送 ==========

  /**
   * 调用 getuploadurl 接口，获取 CDN 上传凭证
   */
  private async getUploadUrl(params: {
    filekey: string;
    mediaType: number;
    toUserId: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskey: string;
  }): Promise<{ upload_param?: string }> {
    const response = await this.request('ilink/bot/getuploadurl', {
      method: 'POST',
      body: JSON.stringify({
        filekey: params.filekey,
        media_type: params.mediaType,
        to_user_id: params.toUserId,
        rawsize: params.rawsize,
        rawfilemd5: params.rawfilemd5,
        filesize: params.filesize,
        no_need_thumb: true,
        aeskey: params.aeskey,
        base_info: { channel_version: '1.0.2' },
      }),
    });
    return response;
  }

  /**
   * 上传本地文件到微信 CDN（AES-128-ECB 加密）
   * 返回 CDN 引用信息，用于后续发送
   */
  async uploadFileToCdn(params: {
    filePath: string;
    toUserId: string;
    mediaType: number;
  }): Promise<UploadedFileInfo> {
    const { filePath, toUserId, mediaType } = params;

    const plaintext = readFileSync(filePath);
    const rawsize = plaintext.length;
    const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = crypto.randomBytes(16).toString('hex');
    const aeskey = crypto.randomBytes(16);

    console.log(`[WeixinAPI] uploadFileToCdn: file=${filePath} rawsize=${rawsize} filesize=${filesize} mediaType=${mediaType}`);

    const uploadUrlResp = await this.getUploadUrl({
      filekey,
      mediaType,
      toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      aeskey: aeskey.toString('hex'),
    });

    const uploadParam = uploadUrlResp.upload_param;
    if (!uploadParam) {
      throw new Error(`getUploadUrl 返回空 upload_param: ${JSON.stringify(uploadUrlResp)}`);
    }

    const { downloadParam: downloadEncryptedQueryParam } = await uploadBufferToCdn({
      buf: plaintext,
      uploadParam,
      filekey,
      cdnBaseUrl: CDN_BASE_URL,
      aeskey,
    });

    return {
      filekey,
      downloadEncryptedQueryParam,
      aeskey: aeskey.toString('hex'),
      fileSize: rawsize,
      fileSizeCiphertext: filesize,
    };
  }

  /**
   * 下载远程 URL 到本地临时文件后上传
   */
  async uploadRemoteFileToCdn(params: {
    url: string;
    toUserId: string;
    mediaType: number;
    filename?: string;
  }): Promise<UploadedFileInfo & { localPath: string }> {
    const { url, toUserId, mediaType, filename } = params;

    console.log(`[WeixinAPI] Downloading remote file: ${url.slice(0, 80)}`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`下载远程文件失败: ${res.status} ${res.statusText}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());

    // 写入临时文件
    const tmpDir = join(process.cwd(), '.agentdev', 'tmp', 'weixin-upload');
    mkdirSync(tmpDir, { recursive: true });
    const ext = filename ? '.' + filename.split('.').pop() : '.bin';
    const tmpPath = join(tmpDir, `upload-${Date.now()}${ext}`);
    writeFileSync(tmpPath, buf);

    try {
      const info = await this.uploadFileToCdn({
        filePath: tmpPath,
        toUserId,
        mediaType,
      });
      return { ...info, localPath: tmpPath };
    } finally {
      // 清理临时文件
      try { existsSync(tmpPath) && writeFileSync(tmpPath, ''); } catch { /* ignore */ }
    }
  }

  /**
   * 发送图片消息
   */
  async sendImageMessage(params: {
    toUserId: string;
    uploaded: UploadedFileInfo;
    contextToken: string;
  }): Promise<SendMessageResponse> {
    const { toUserId, uploaded, contextToken } = params;

    const requestBody = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: this.generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: contextToken,
        item_list: [{
          type: ItemType.IMAGE,
          image_item: {
            media: {
              encrypt_query_param: uploaded.downloadEncryptedQueryParam,
              aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
              encrypt_type: 1,
            },
            mid_size: uploaded.fileSizeCiphertext,
          },
        }],
      },
      base_info: { channel_version: '1.0.2' },
    };

    return this.request('ilink/bot/sendmessage', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
  }

  /**
   * 发送视频消息
   */
  async sendVideoMessage(params: {
    toUserId: string;
    uploaded: UploadedFileInfo;
    contextToken: string;
  }): Promise<SendMessageResponse> {
    const { toUserId, uploaded, contextToken } = params;

    const requestBody = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: this.generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: contextToken,
        item_list: [{
          type: ItemType.VIDEO,
          video_item: {
            media: {
              encrypt_query_param: uploaded.downloadEncryptedQueryParam,
              aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
              encrypt_type: 1,
            },
            video_size: uploaded.fileSizeCiphertext,
          },
        }],
      },
      base_info: { channel_version: '1.0.2' },
    };

    return this.request('ilink/bot/sendmessage', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
  }

  /**
   * 发送文件消息
   */
  async sendFileMessage(params: {
    toUserId: string;
    fileName: string;
    uploaded: UploadedFileInfo;
    contextToken: string;
  }): Promise<SendMessageResponse> {
    const { toUserId, fileName, uploaded, contextToken } = params;

    const requestBody = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: this.generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: contextToken,
        item_list: [{
          type: ItemType.FILE,
          file_item: {
            media: {
              encrypt_query_param: uploaded.downloadEncryptedQueryParam,
              aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
              encrypt_type: 1,
            },
            file_name: fileName,
            len: String(uploaded.fileSize),
          },
        }],
      },
      base_info: { channel_version: '1.0.2' },
    };

    return this.request('ilink/bot/sendmessage', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
  }

  /**
   * 发送语音消息
   *
   * encode_type 映射:
   *   1=pcm(wav) 5=amr 6=silk 7=mp3 8=ogg-speex
   */
  async sendVoiceMessage(params: {
    toUserId: string;
    uploaded: UploadedFileInfo;
    contextToken: string;
    encodeType: number;
    sampleRate: number;
    playtime: number;
  }): Promise<SendMessageResponse> {
    const { toUserId, uploaded, contextToken, encodeType, sampleRate, playtime } = params;

    const requestBody = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: this.generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: contextToken,
        item_list: [{
          type: ItemType.VOICE,
          voice_item: {
            media: {
              encrypt_query_param: uploaded.downloadEncryptedQueryParam,
              aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
              encrypt_type: 1,
            },
            encode_type: encodeType,
            sample_rate: sampleRate,
            playtime,
          },
        }],
      },
      base_info: { channel_version: '1.0.2' },
    };

    return this.request('ilink/bot/sendmessage', {
      method: 'POST',
      body: JSON.stringify(requestBody),
    });
  }

  /**
   * 统一发送媒体文件：根据 MIME 类型自动路由到图片/视频/文件
   */
  async sendMediaFile(params: {
    filePath: string;
    toUserId: string;
    contextToken: string;
  }): Promise<{ messageId: string; type: string }> {
    const { filePath, toUserId, contextToken } = params;
    const mime = getMimeFromFilename(filePath);

    let mediaType: number;
    let typeLabel: string;

    if (mime.startsWith('image/')) {
      mediaType = UploadMediaType.IMAGE;
      typeLabel = '图片';
    } else if (mime.startsWith('video/')) {
      mediaType = UploadMediaType.VIDEO;
      typeLabel = '视频';
    } else {
      mediaType = UploadMediaType.FILE;
      typeLabel = '文件';
    }

    console.log(`[WeixinAPI] sendMediaFile: uploading ${typeLabel} filePath=${filePath}`);

    const uploaded = await this.uploadFileToCdn({
      filePath,
      toUserId,
      mediaType,
    });

    console.log(`[WeixinAPI] sendMediaFile: upload done filekey=${uploaded.filekey}, sending message...`);

    if (mime.startsWith('image/')) {
      await this.sendImageMessage({ toUserId, uploaded, contextToken });
    } else if (mime.startsWith('video/')) {
      await this.sendVideoMessage({ toUserId, uploaded, contextToken });
    } else {
      await this.sendFileMessage({
        toUserId,
        fileName: basename(filePath),
        uploaded,
        contextToken,
      });
    }

    console.log(`[WeixinAPI] sendMediaFile: ${typeLabel} sent successfully`);
    return { messageId: '', type: typeLabel };
  }

  /**
   * 提取消息中的文本内容
   */
  static extractText(message: WeixinMessage): string | null {
    for (const item of message.item_list) {
      if (item.type === ItemType.TEXT) {
        const textItem = item as TextItem;
        return textItem.text_item.text;
      }
    }
    return null;
  }

  static resolveQrcodeUrl(qrcodeResponse: QrcodeResponse): string {
    if (qrcodeResponse.qrcode_img_content && qrcodeResponse.qrcode_img_content.startsWith('http')) {
      return qrcodeResponse.qrcode_img_content;
    }
    if (qrcodeResponse.url) {
      return qrcodeResponse.url;
    }

    console.error('错误：API 未返回有效的二维码 URL');
    console.log('返回数据:', qrcodeResponse);
    throw new Error('无法获取二维码 URL');
  }

  static async buildQrcodeDataUrl(
    qrcodeResponse: QrcodeResponse,
    options: { width?: number; margin?: number } = {},
  ): Promise<string> {
    const qrcodeUrl = WeixinApiClient.resolveQrcodeUrl(qrcodeResponse);
    const QRCode = (await import('qrcode')).default;
    return QRCode.toDataURL(qrcodeUrl, {
      width: options.width ?? 300,
      margin: options.margin ?? 2,
    });
  }
}
