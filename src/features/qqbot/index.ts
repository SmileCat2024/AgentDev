/**
 * QQBotFeature - QQ 机器人对话能力
 *
 * 功能：
 * - 通过 WebSocket 连接 QQ Bot Gateway
 * - 接收 QQ 消息并转发给 Agent 处理
 * - 自动将 Agent 的响应发送回 QQ
 *
 * 使用 `@sliverp/qqbot/standalone` 独立接入
 */

import type { Tool } from '../../core/types.js';
import type { AgentFeature, FeatureInitContext, FeatureContext, PackageInfo } from '../../core/feature.js';
import { getPackageInfoFromSource } from '../../core/feature.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// 从 qqbot 的 standalone 入口导入
import type {
  ResolvedQQBotAccount,
  QQBotInboundRequest,
  OutboundResult
} from '@sliverp/qqbot/standalone';
import {
  createQQBotAgentAdapter,
  startGateway
} from '@sliverp/qqbot/standalone';

/**
 * QQBot 配置文件结构
 */
interface QQBotConfigFile {
  appId: string;
  clientSecret: string;
}

/**
 * QQ 消息发送选项
 */
export interface QQBotSendOptions {
  /** 目标 OpenID */
  to: string;
  /** 消息内容 */
  content: string;
}

/**
 * QQ 消息发送结果
 */
export interface QQBotSendResult {
  /** 是否成功 */
  success: boolean;
  /** 消息ID */
  messageId?: string;
  /** 时间戳 */
  timestamp?: string | number;
  /** 错误信息 */
  error?: string;
}

/**
 * 已知用户信息
 */
export interface KnownUser {
  /** 类型 */
  type: 'c2c' | 'group' | 'channel';
  /** OpenID */
  openid: string;
  /** 昵称 */
  nickname?: string;
  /** 最后交互时间 */
  lastInteractionAt: number;
}

/**
 * QQBot Feature 配置
 */
export interface QQBotFeatureConfig {
  /** QQ Bot AppID（可选，如果不提供则从配置文件读取） */
  appId?: string;
  /** QQ Bot AppSecret（可选，如果不提供则从配置文件读取） */
  clientSecret?: string;
  /** 配置文件路径（默认 .agentdev/qqbot.config.json） */
  configPath?: string;
  /** 账户 ID（默认 "default"） */
  accountId?: string;
  /** 是否启用 Markdown 消息（默认 true） */
  markdownSupport?: boolean;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 附加配置（传递给 Gateway） */
  cfg?: Record<string, unknown>;
}

/**
 * 从配置文件读取 QQ Bot 凭据
 */
function loadConfigFromFile(configPath: string): QQBotConfigFile | null {
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as QQBotConfigFile;
  } catch (err) {
    console.error(`[QQBotFeature] 读取配置文件失败 ${configPath}:`, err);
    return null;
  }
}

/**
 * QQBotFeature - QQ 机器人 Feature
 *
 * 使用方式：
 * ```typescript
 * const qqbotFeature = new QQBotFeature({ appId, clientSecret });
 * const agent = new BasicAgent({ llm }).use(qqbotFeature);
 * await agent.withViewer('QQBot', 2026, false);
 * await qqbotFeature.startGateway(agent);
 * ```
 */
export class QQBotFeature implements AgentFeature {
  readonly name = 'qqbot';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description = '把 Agent 接入 QQ Bot 网关，接收消息并把回复回推到 QQ 会话。';

  private config: QQBotFeatureConfig;
  private agentRef: any = null; // Agent 实例引用
  private processingLock: Promise<void> = Promise.resolve();
  private gatewayStarted: boolean = false;
  private abortController: AbortController | null = null;
  private _packageInfo: PackageInfo | null = null;

  constructor(config: QQBotFeatureConfig = {}) {
    this.config = config;
  }

  /**
   * 显式启动 Gateway（在 Agent 初始化后调用）
   *
   * @param agent Agent 实例
   */
  async startGateway(agent: any): Promise<void> {
    if (this.gatewayStarted) {
      console.log('[QQBotFeature] Gateway already started');
      return;
    }

    this.agentRef = agent;
    this.abortController = new AbortController();

    const account = this.createAccount();

    startGateway({
      account,
      cfg: this.config.cfg || {},
      abortSignal: this.abortController.signal,
      agentAdapter: createQQBotAgentAdapter(async (request: QQBotInboundRequest) => {
        if (!this.agentRef) {
          console.error('[QQBotFeature] Agent not initialized');
          return { text: '机器人未初始化，请稍后重试' };
        }

        console.log(`[QQBotFeature] 收到消息: ${request.text}`);

        // 串行处理消息（确保同一用户的消息按顺序处理）
        this.processingLock = this.processingLock.then(async () => {
          return await this.agentRef.onCall(request.text);
        });

        try {
          const response = await this.processingLock;
          // response 可能是 string，也可能是 void（但 onCall 应该总是返回 string）
          const responseText = typeof response === 'string' ? response : '处理完成';
          console.log(`[QQBotFeature] 响应: ${responseText.slice(0, 100)}...`);
          return { text: responseText };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error('[QQBotFeature] 处理消息失败:', errorMsg);
          return { text: `处理失败: ${errorMsg}` };
        }
      }),
      log: {
        info: (msg: string) => console.log(`[QQBotFeature] ${msg}`),
        error: (msg: string) => console.error(`[QQBotFeature] ${msg}`),
      },
    }).catch((err) => {
      if (err.name === 'AbortError') {
        console.log('[QQBotFeature] Gateway stopped');
      } else {
        console.error('[QQBotFeature] Gateway error:', err);
      }
    });

    this.gatewayStarted = true;
    console.log('[QQBotFeature] Gateway started');
  }

  /**
   * 创建账户配置
   */
  private createAccount(): ResolvedQQBotAccount {
    const credentials = this.getCredentials();

    return {
      accountId: this.config.accountId ?? 'default',
      enabled: true,
      appId: credentials.appId,
      clientSecret: credentials.clientSecret,
      secretSource: 'config',
      markdownSupport: this.config.markdownSupport ?? true,
      config: {
        allowFrom: ['*'],
        systemPrompt: this.config.systemPrompt,
        markdownSupport: this.config.markdownSupport ?? true,
      }
    };
  }

  /**
   * 获取凭据（从配置文件或直接配置）
   */
  private getCredentials(): { appId: string; clientSecret: string } {
    // 如果直接提供了凭据，优先使用
    if (this.config.appId && this.config.clientSecret) {
      return {
        appId: this.config.appId,
        clientSecret: this.config.clientSecret
      };
    }

    // 否则从配置文件读取
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const projectRoot = join(currentDir, '../../..');
    const defaultConfigPath = join(projectRoot, '.agentdev', 'qqbot.config.json');
    const configPath = this.config.configPath || defaultConfigPath;

    const fileConfig = loadConfigFromFile(configPath);

    if (!fileConfig || !fileConfig.appId || !fileConfig.clientSecret) {
      throw new Error(
        `QQBot 凭据未配置。\n` +
        `请在 ${defaultConfigPath} 中配置 appId 和 clientSecret，\n` +
        `或在创建 QQBotFeature 时直接传入配置。\n\n` +
        `配置文件格式：\n` +
        `{\n  "appId": "your-appid",\n  "clientSecret": "your-secret"\n}`
      );
    }

    return {
      appId: fileConfig.appId,
      clientSecret: fileConfig.clientSecret
    };
  }

  // ========== AgentFeature 接口 ==========

  getTools(): Tool[] {
    return [];
  }

  /**
   * 获取包信息（统一打包方案）
   */
  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  /**
   * 获取模板名称列表（统一打包方案）
   * 此 Feature 没有模板，返回空数组
   */
  getTemplateNames(): string[] {
    return [];
  }

  async onInitiate(_ctx: FeatureInitContext): Promise<void> {
    // Gateway 通过显式调用 startGateway 启动，不在这里自动启动
    console.log('[QQBotFeature] Feature initialized');
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.gatewayStarted = false;
    console.log('[QQBotFeature] Destroyed');
  }
}

// 导出 qqbot 相关类型供外部使用
export type { QQBotInboundRequest, ResolvedQQBotAccount, OutboundResult };
