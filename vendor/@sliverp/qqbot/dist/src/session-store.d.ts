/**
 * Session 持久化存储
 * 将 WebSocket 连接状态（sessionId、lastSeq）持久化到文件
 * 支持进程重启后通过 Resume 机制快速恢复连接
 */
export interface SessionState {
    /** WebSocket Session ID */
    sessionId: string | null;
    /** 最后收到的消息序号 */
    lastSeq: number | null;
    /** 上次连接成功的时间戳 */
    lastConnectedAt: number;
    /** 上次成功的权限级别索引 */
    intentLevelIndex: number;
    /** 关联的机器人账户 ID */
    accountId: string;
    /** 保存时间 */
    savedAt: number;
    /** 创建此 session 时使用的 appId（用于检测凭据变更） */
    appId?: string;
}
/**
 * 加载 Session 状态
 * @param accountId 账户 ID
 * @param expectedAppId 当前使用的 appId，如果与保存时的 appId 不匹配则视为失效
 * @returns Session 状态，如果不存在、已过期或 appId 不匹配返回 null
 */
export declare function loadSession(accountId: string, expectedAppId?: string): SessionState | null;
/**
 * 保存 Session 状态（带节流，避免频繁写入）
 * @param state Session 状态
 */
export declare function saveSession(state: SessionState): void;
/**
 * 清除 Session 状态
 * @param accountId 账户 ID
 */
export declare function clearSession(accountId: string): void;
/**
 * 更新 lastSeq（轻量级更新）
 * @param accountId 账户 ID
 * @param lastSeq 最新的消息序号
 */
export declare function updateLastSeq(accountId: string, lastSeq: number): void;
/**
 * 获取所有保存的 Session 状态
 */
export declare function getAllSessions(): SessionState[];
/**
 * 清理过期的 Session 文件
 */
export declare function cleanupExpiredSessions(): number;
