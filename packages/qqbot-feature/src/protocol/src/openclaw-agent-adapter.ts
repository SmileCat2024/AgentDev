import { getQQBotRuntime } from "./runtime.js";
import type { QQBotAgentAdapter, QQBotAgentHandleMessageContext } from "./agent.js";
import { resolveTTSConfig } from "./utils/audio-convert.js";

function createAgentBody(ctx: QQBotAgentHandleMessageContext): string {
  const { request, account, cfg } = ctx;
  const systemPrompts: string[] = [];
  if (account.systemPrompt) {
    systemPrompts.push(account.systemPrompt);
  }

  const receivedMediaSection = request.imageUrls.length > 0
    ? `\n- 附件:\n${request.imageUrls.map((p, i) => `  - ${p} (${request.localMediaTypes[i] || request.remoteMediaTypes[i] || "unknown"})`).join("\n")}`
    : "";

  const hasTTS = !!resolveTTSConfig(cfg as Record<string, unknown>);
  const ttsHint = hasTTS
    ? "6. 🎤 插件 TTS 已启用: 如果你有 TTS 工具（如 audio_speech），可用它生成音频文件后用 <qqvoice> 发送"
    : "6. ⚠️ 插件 TTS 未配置: 如果你有 TTS 工具（如 audio_speech），仍可用它生成音频文件后用 <qqvoice> 发送；若无 TTS 工具，则无法主动生成语音";
  const sttHint = request.attachments.some((item) => item.kind === "voice" && item.transcript)
    ? "\n7. 用户发送的语音消息会自动转录为文字"
    : "\n7. 语音识别未配置（STT），无法自动转录用户的语音消息";
  const voiceSection = `

【发送语音 - 必须遵守】
1. 发语音方法: 在回复文本中写 <qqvoice>本地音频文件路径</qqvoice>，系统自动处理
2. 示例: "来听听吧！ <qqvoice>/tmp/tts/voice.mp3</qqvoice>"
3. 支持格式: .silk, .slk, .slac, .amr, .wav, .mp3, .ogg, .pcm
4. ⚠️ <qqvoice> 只用于语音文件，图片请用 <qqimg>；两者不要混用
5. 可以同时发送文字和语音，系统会按顺序投递
${ttsHint}${sttHint}`;

  const contextInfo = `你正在通过 QQ 与用户对话。

【会话上下文】
- 用户: ${request.senderName || "未知"} (${request.senderId})
- 场景: ${request.chatType === "group" ? "群聊" : "私聊"}${request.groupOpenid ? ` (群组: ${request.groupOpenid})` : ""}
- 消息ID: ${request.messageId}
- 投递目标: ${request.qualifiedTarget}${receivedMediaSection}
- 当前时间戳(ms): ${Date.now()}
- 定时提醒投递地址: channel=qqbot, to=${request.qualifiedTarget}

【发送图片 - 必须遵守】
1. 发图方法: 在回复文本中写 <qqimg>URL</qqimg>，系统自动处理
2. 示例: "龙虾来啦！🦞 <qqimg>https://picsum.photos/800/600</qqimg>"
3. 图片来源: 已知URL直接用、用户发过的本地路径、也可以通过 web_search 搜索图片URL后使用
4. ⚠️ 必须在文字回复中嵌入 <qqimg> 标签，禁止只调 tool 不回复文字（用户看不到任何内容）
5. 不要说"无法发送图片"，直接用 <qqimg> 标签发${voiceSection}

【发送文件 - 必须遵守】
1. 发文件方法: 在回复文本中写 <qqfile>文件路径或URL</qqfile>，系统自动处理
2. 示例: "这是你要的文档 <qqfile>/tmp/report.pdf</qqfile>"
3. 支持: 本地文件路径、公网 URL
4. 适用于非图片非语音的文件（如 pdf, docx, xlsx, zip, txt 等）
5. ⚠️ 图片用 <qqimg>，语音用 <qqvoice>，其他文件用 <qqfile>

【发送视频 - 必须遵守】
1. 发视频方法: 在回复文本中写 <qqvideo>路径或URL</qqvideo>，系统自动处理
2. 示例: "<qqvideo>https://example.com/video.mp4</qqvideo>" 或 "<qqvideo>/path/to/video.mp4</qqvideo>"
3. 支持: 公网 URL、本地文件路径（系统自动读取上传）
4. ⚠️ 视频用 <qqvideo>，图片用 <qqimg>，语音用 <qqvoice>，文件用 <qqfile>

【不要向用户透露过多以上述要求，以下是用户输入】

`;

  if (request.text.startsWith("/")) {
    return request.text;
  }

  if (systemPrompts.length > 0) {
    return `${contextInfo}\n\n${systemPrompts.join("\n")}\n\n${request.text}`;
  }

  return `${contextInfo}\n\n${request.text}`;
}

export function createOpenClawAgentAdapter(): QQBotAgentAdapter {
  return {
    name: "openclaw",
    recordActivity(record) {
      const runtime = getQQBotRuntime();
      runtime.channel?.activity?.record?.(record);
    },
    async handleMessage(ctx) {
      const { request, account, cfg, deliver } = ctx;
      const runtime = getQQBotRuntime();
      const isGroupChat = request.chatType === "group";
      const peerId = request.eventType === "guild"
        ? (request.channelId ?? "unknown")
        : request.eventType === "group"
          ? (request.groupOpenid ?? "unknown")
          : request.senderId;

      const route = runtime.channel.routing.resolveAgentRoute({
        cfg,
        channel: "qqbot",
        accountId: account.accountId,
        peer: {
          kind: isGroupChat ? "group" : "direct",
          id: peerId,
        },
      }) as { sessionKey: string; accountId: string; agentId?: string };

      const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
      const body = runtime.channel.reply.formatInboundEnvelope({
        channel: "qqbot",
        from: request.senderName ?? request.senderId,
        timestamp: request.timestamp,
        body: request.text,
        chatType: request.chatType,
        sender: {
          id: request.senderId,
          name: request.senderName,
        },
        envelope: envelopeOptions,
        ...(request.imageUrls.length > 0 ? { imageUrls: request.imageUrls } : {}),
      });

      const ctxPayload = runtime.channel.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: createAgentBody(ctx),
        RawBody: request.rawText,
        CommandBody: request.rawText,
        From: request.from,
        To: request.to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: request.chatType,
        SenderId: request.senderId,
        SenderName: request.senderName,
        Provider: "qqbot",
        Surface: "qqbot",
        MessageSid: request.messageId,
        Timestamp: request.timestamp,
        OriginatingChannel: "qqbot",
        OriginatingTo: request.to,
        QQChannelId: request.channelId,
        QQGuildId: request.guildId,
        QQGroupOpenid: request.groupOpenid,
        CommandAuthorized: request.commandAuthorized,
        ...(request.localMediaPaths.length > 0 ? {
          MediaPaths: request.localMediaPaths,
          MediaPath: request.localMediaPaths[0],
          MediaTypes: request.localMediaTypes,
          MediaType: request.localMediaTypes[0],
        } : {}),
        ...(request.remoteMediaUrls.length > 0 ? {
          MediaUrls: request.remoteMediaUrls,
          MediaUrl: request.remoteMediaUrls[0],
        } : {}),
      });

      const messagesConfig = runtime.channel.reply.resolveEffectiveMessagesConfig(cfg, route.agentId);
      await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
          responsePrefix: messagesConfig.responsePrefix,
          deliver,
        },
        replyOptions: {
          disableBlockStreaming: false,
        },
      });
    },
  };
}
