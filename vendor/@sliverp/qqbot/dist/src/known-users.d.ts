/**
 * 已知用户存储
 * 记录与机器人交互过的所有用户
 * 支持主动消息和批量通知功能
 */
export interface KnownUser {
    /** 用户 openid（唯一标识） */
    openid: string;
    /** 消息类型：私聊用户 / 群组 */
    type: "c2c" | "group";
    /** 用户昵称（如有） */
    nickname?: string;
    /** 群组 openid（如果是群消息） */
    groupOpenid?: string;
    /** 关联的机器人账户 ID */
    accountId: string;
    /** 首次交互时间戳 */
    firstSeenAt: number;
    /** 最后交互时间戳 */
    lastSeenAt: number;
    /** 交互次数 */
    interactionCount: number;
}
/**
 * 强制立即保存（用于进程退出前）
 */
export declare function flushKnownUsers(): void;
/**
 * 记录已知用户（收到消息时调用）
 * @param user 用户信息（部分字段）
 */
export declare function recordKnownUser(user: {
    openid: string;
    type: "c2c" | "group";
    nickname?: string;
    groupOpenid?: string;
    accountId: string;
}): void;
/**
 * 获取单个用户信息
 * @param accountId 机器人账户 ID
 * @param openid 用户 openid
 * @param type 消息类型
 * @param groupOpenid 群组 openid（可选）
 */
export declare function getKnownUser(accountId: string, openid: string, type?: "c2c" | "group", groupOpenid?: string): KnownUser | undefined;
/**
 * 列出所有已知用户
 * @param options 筛选选项
 */
export declare function listKnownUsers(options?: {
    /** 筛选特定机器人账户的用户 */
    accountId?: string;
    /** 筛选消息类型 */
    type?: "c2c" | "group";
    /** 最近活跃时间（毫秒，如 86400000 表示最近 24 小时） */
    activeWithin?: number;
    /** 返回数量限制 */
    limit?: number;
    /** 排序方式 */
    sortBy?: "lastSeenAt" | "firstSeenAt" | "interactionCount";
    /** 排序方向 */
    sortOrder?: "asc" | "desc";
}): KnownUser[];
/**
 * 获取用户统计信息
 * @param accountId 机器人账户 ID（可选，不传则返回所有账户的统计）
 */
export declare function getKnownUsersStats(accountId?: string): {
    totalUsers: number;
    c2cUsers: number;
    groupUsers: number;
    activeIn24h: number;
    activeIn7d: number;
};
/**
 * 删除用户记录
 * @param accountId 机器人账户 ID
 * @param openid 用户 openid
 * @param type 消息类型
 * @param groupOpenid 群组 openid（可选）
 */
export declare function removeKnownUser(accountId: string, openid: string, type?: "c2c" | "group", groupOpenid?: string): boolean;
/**
 * 清除所有用户记录
 * @param accountId 机器人账户 ID（可选，不传则清除所有）
 */
export declare function clearKnownUsers(accountId?: string): number;
/**
 * 获取用户的所有群组（某用户在哪些群里交互过）
 * @param accountId 机器人账户 ID
 * @param openid 用户 openid
 */
export declare function getUserGroups(accountId: string, openid: string): string[];
/**
 * 获取群组的所有成员
 * @param accountId 机器人账户 ID
 * @param groupOpenid 群组 openid
 */
export declare function getGroupMembers(accountId: string, groupOpenid: string): KnownUser[];
