import type { ResolvedQQBotAccount } from "./types.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
export declare const DEFAULT_ACCOUNT_ID = "default";
/**
 * 列出所有 QQBot 账户 ID
 */
export declare function listQQBotAccountIds(cfg: OpenClawConfig): string[];
/**
 * 获取默认账户 ID
 */
export declare function resolveDefaultQQBotAccountId(cfg: OpenClawConfig): string;
/**
 * 解析 QQBot 账户配置
 */
export declare function resolveQQBotAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedQQBotAccount;
/**
 * 应用账户配置
 */
export declare function applyQQBotAccountConfig(cfg: OpenClawConfig, accountId: string, input: {
    appId?: string;
    clientSecret?: string;
    clientSecretFile?: string;
    name?: string;
    imageServerBaseUrl?: string;
}): OpenClawConfig;
