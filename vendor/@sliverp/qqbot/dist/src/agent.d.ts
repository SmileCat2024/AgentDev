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
export type QQBotSimpleAgentResult = string | QQBotAgentOutput | Array<string | QQBotAgentOutput> | null | undefined;
export type QQBotSimpleAgentHandler = (request: QQBotInboundRequest, ctx: QQBotSimpleAgentContext) => Promise<QQBotSimpleAgentResult> | QQBotSimpleAgentResult;
export declare function createQQBotAgentAdapter(handler: QQBotSimpleAgentHandler): QQBotAgentAdapter;
export declare function setQQBotAgentAdapter(adapter: QQBotAgentAdapter | null): void;
export declare function getQQBotAgentAdapter(): QQBotAgentAdapter | null;
