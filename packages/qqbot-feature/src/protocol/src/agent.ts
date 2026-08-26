import type { ResolvedQQBotAccount } from "./types.js";

export interface QQBotAgentLog {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface QQBotInboundAttachment {
  kind: "image" | "voice" | "file";
  contentType?: string;
  fileName?: string;
  originalUrl?: string;
  localPath?: string;
  transcript?: string;
}

export interface QQBotInboundRequest {
  channel: "qqbot";
  accountId: string;
  eventType: "c2c" | "guild" | "dm" | "group";
  chatType: "direct" | "group";
  senderId: string;
  senderName?: string;
  messageId: string;
  timestamp: number;
  rawText: string;
  text: string;
  from: string;
  to: string;
  qualifiedTarget: string;
  commandAuthorized: boolean;
  channelId?: string;
  guildId?: string;
  groupOpenid?: string;
  imageUrls: string[];
  localMediaPaths: string[];
  localMediaTypes: string[];
  remoteMediaUrls: string[];
  remoteMediaTypes: string[];
  attachments: QQBotInboundAttachment[];
}

export interface QQBotAgentOutput {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
}

export interface QQBotAgentDeliverInfo {
  kind: string;
}

export interface QQBotAgentActivityRecord {
  channel: "qqbot";
  accountId: string;
  direction: "inbound" | "outbound";
}

export interface QQBotAgentHandleMessageContext {
  request: QQBotInboundRequest;
  account: ResolvedQQBotAccount;
  cfg: unknown;
  abortSignal: AbortSignal;
  log?: QQBotAgentLog;
  deliver: (payload: QQBotAgentOutput, info: QQBotAgentDeliverInfo) => Promise<void>;
}

export interface QQBotAgentAdapter {
  name?: string;
  recordActivity?: (record: QQBotAgentActivityRecord) => void;
  handleMessage: (ctx: QQBotAgentHandleMessageContext) => Promise<void>;
}

export interface QQBotSimpleAgentContext {
  account: ResolvedQQBotAccount;
  cfg: unknown;
  abortSignal: AbortSignal;
  log?: QQBotAgentLog;
}

export type QQBotSimpleAgentResult =
  | string
  | QQBotAgentOutput
  | Array<string | QQBotAgentOutput>
  | null
  | undefined;

export type QQBotSimpleAgentHandler = (
  request: QQBotInboundRequest,
  ctx: QQBotSimpleAgentContext
) => Promise<QQBotSimpleAgentResult> | QQBotSimpleAgentResult;

function normalizeSimpleResult(result: QQBotSimpleAgentResult): QQBotAgentOutput[] {
  if (result === null || result === undefined) {
    return [];
  }
  if (typeof result === "string") {
    return [{ text: result }];
  }
  if (Array.isArray(result)) {
    return result.flatMap((item) => normalizeSimpleResult(item));
  }
  return [result];
}

export function createQQBotAgentAdapter(handler: QQBotSimpleAgentHandler): QQBotAgentAdapter {
  return {
    name: "custom",
    async handleMessage(ctx) {
      const result = await handler(ctx.request, {
        account: ctx.account,
        cfg: ctx.cfg,
        abortSignal: ctx.abortSignal,
        log: ctx.log,
      });
      const outputs = normalizeSimpleResult(result);
      for (const output of outputs) {
        await ctx.deliver(output, { kind: "message" });
      }
    },
  };
}

let currentAgentAdapter: QQBotAgentAdapter | null = null;

export function setQQBotAgentAdapter(adapter: QQBotAgentAdapter | null): void {
  currentAgentAdapter = adapter;
}

export function getQQBotAgentAdapter(): QQBotAgentAdapter | null {
  return currentAgentAdapter;
}
