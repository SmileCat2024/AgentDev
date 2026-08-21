/**
 * QQ Bot 主动发送消息模块
 *
 * 该模块提供以下能力：
 * 1. 记录已知用户（曾与机器人交互过的用户）
 * 2. 主动发送消息给用户或群组
 * 3. 查询已知用户列表
 */
import type { ResolvedQQBotAccount } from "./types.js";
/**
 * 已知用户信息
 */
export interface KnownUser {
    type: "c2c" | "group" | "channel";
    openid: string;
    accountId: string;
    nickname?: string;
    firstInteractionAt: number;
    lastInteractionAt: number;
}
/**
 * 主动发送消息选项
 */
export interface ProactiveSendOptions {
    to: string;
    text: string;
    type?: "c2c" | "group" | "channel";
    imageUrl?: string;
    accountId?: string;
}
/**
 * 主动发送消息结果
 */
export interface ProactiveSendResult {
    success: boolean;
    messageId?: string;
    timestamp?: number | string;
    error?: string;
}
/**
 * 列出已知用户选项
 */
export interface ListKnownUsersOptions {
    type?: "c2c" | "group" | "channel";
    accountId?: string;
    sortByLastInteraction?: boolean;
    limit?: number;
}
import type { OpenClawConfig } from "openclaw/plugin-sdk";
/**
 * 记录一个已知用户（当收到用户消息时调用）
 *
 * @param user - 用户信息
 */
export declare function recordKnownUser(user: Omit<KnownUser, "firstInteractionAt">): void;
/**
 * 获取一个已知用户
 *
 * @param type - 用户类型
 * @param openid - 用户 openid
 * @param accountId - 账户 ID
 */
export declare function getKnownUser(type: string, openid: string, accountId: string): KnownUser | undefined;
/**
 * 列出已知用户
 *
 * @param options - 过滤选项
 */
export declare function listKnownUsers(options?: ListKnownUsersOptions): KnownUser[];
/**
 * 删除一个已知用户
 *
 * @param type - 用户类型
 * @param openid - 用户 openid
 * @param accountId - 账户 ID
 */
export declare function removeKnownUser(type: string, openid: string, accountId: string): boolean;
/**
 * 清除所有已知用户
 *
 * @param accountId - 可选，只清除指定账户的用户
 */
export declare function clearKnownUsers(accountId?: string): number;
/**
 * 主动发送消息（带配置解析）
 * 注意：与 outbound.ts 中的 sendProactiveMessage 不同，这个函数接受 OpenClawConfig 并自动解析账户
 *
 * @param options - 发送选项
 * @param cfg - OpenClaw 配置
 * @returns 发送结果
 *
 * @example
 * ```typescript
 * // 发送私聊消息
 * const result = await sendProactive({
 *   to: "E7A8F3B2C1D4E5F6A7B8C9D0E1F2A3B4",  // 用户 openid
 *   text: "你好！这是一条主动消息",
 *   type: "c2c",
 * }, cfg);
 *
 * // 发送群聊消息
 * const result = await sendProactive({
 *   to: "A1B2C3D4E5F6A7B8",  // 群组 openid
 *   text: "群公告：今天有活动",
 *   type: "group",
 * }, cfg);
 *
 * // 发送带图片的消息
 * const result = await sendProactive({
 *   to: "E7A8F3B2C1D4E5F6A7B8C9D0E1F2A3B4",
 *   text: "看看这张图片",
 *   imageUrl: "https://example.com/image.png",
 *   type: "c2c",
 * }, cfg);
 * ```
 */
export declare function sendProactive(options: ProactiveSendOptions, cfg: OpenClawConfig): Promise<ProactiveSendResult>;
/**
 * 批量发送主动消息
 *
 * @param recipients - 接收者列表（openid 数组）
 * @param text - 消息内容
 * @param type - 消息类型
 * @param cfg - OpenClaw 配置
 * @param accountId - 账户 ID
 * @returns 发送结果列表
 */
export declare function sendBulkProactiveMessage(recipients: string[], text: string, type: "c2c" | "group", cfg: OpenClawConfig, accountId?: string): Promise<Array<{
    to: string;
    result: ProactiveSendResult;
}>>;
/**
 * 发送消息给所有已知用户
 *
 * @param text - 消息内容
 * @param cfg - OpenClaw 配置
 * @param options - 过滤选项
 * @returns 发送结果统计
 */
export declare function broadcastMessage(text: string, cfg: OpenClawConfig, options?: {
    type?: "c2c" | "group";
    accountId?: string;
    limit?: number;
}): Promise<{
    total: number;
    success: number;
    failed: number;
    results: Array<{
        to: string;
        result: ProactiveSendResult;
    }>;
}>;
/**
 * 根据账户配置直接发送主动消息（不需要 cfg）
 *
 * @param account - 已解析的账户配置
 * @param to - 目标 openid
 * @param text - 消息内容
 * @param type - 消息类型
 */
export declare function sendProactiveMessageDirect(account: ResolvedQQBotAccount, to: string, text: string, type?: "c2c" | "group"): Promise<ProactiveSendResult>;
/**
 * 获取已知用户统计
 */
export declare function getKnownUsersStats(accountId?: string): {
    total: number;
    c2c: number;
    group: number;
    channel: number;
};
