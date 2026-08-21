/**
 * QQ Bot API 鉴权和请求封装
 * [修复版] 已重构为支持多实例并发，消除全局变量冲突
 */
import { computeFileHash, getCachedFileInfo, setCachedFileInfo } from "./utils/upload-cache.js";
import { sanitizeFileName } from "./utils/platform.js";
const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
// 运行时配置
let currentMarkdownSupport = false;
/**
 * 初始化 API 配置
 * @param options.markdownSupport - 是否支持 markdown 消息（默认 false，需要机器人具备该权限才能启用）
 */
export function initApiConfig(options) {
    currentMarkdownSupport = options.markdownSupport === true;
}
/**
 * 获取当前是否支持 markdown
 */
export function isMarkdownSupport() {
    return currentMarkdownSupport;
}
// =========================================================================
// 🚀 [核心修复] 将全局状态改为 Map，按 appId 隔离，彻底解决多账号串号问题
// =========================================================================
const tokenCacheMap = new Map();
const tokenFetchPromises = new Map();
/**
 * 获取 AccessToken（带缓存 + singleflight 并发安全）
 *
 * 使用 singleflight 模式：当多个请求同时发现 Token 过期时，
 * 只有第一个请求会真正去获取新 Token，其他请求复用同一个 Promise。
 *
 * 按 appId 隔离，支持多机器人并发请求。
 */
export async function getAccessToken(appId, clientSecret) {
    const cachedToken = tokenCacheMap.get(appId);
    // 检查缓存：未过期 且 appId 未变化 时复用
    if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000) {
        return cachedToken.token;
    }
    // Singleflight: 如果当前 appId 已有进行中的 Token 获取请求，复用它
    let fetchPromise = tokenFetchPromises.get(appId);
    if (fetchPromise) {
        console.log(`[qqbot-api:${appId}] Token fetch in progress, waiting for existing request...`);
        return fetchPromise;
    }
    // 创建新的 Token 获取 Promise（singleflight 入口）
    fetchPromise = (async () => {
        try {
            return await doFetchToken(appId, clientSecret);
        }
        finally {
            // 无论成功失败，都清除 Promise 缓存
            tokenFetchPromises.delete(appId);
        }
    })();
    tokenFetchPromises.set(appId, fetchPromise);
    return fetchPromise;
}
/**
 * 实际执行 Token 获取的内部函数
 */
async function doFetchToken(appId, clientSecret) {
    const requestBody = { appId, clientSecret };
    const requestHeaders = { "Content-Type": "application/json" };
    // 打印请求信息（隐藏敏感信息）
    console.log(`[qqbot-api:${appId}] >>> POST ${TOKEN_URL}`);
    let response;
    try {
        response = await fetch(TOKEN_URL, {
            method: "POST",
            headers: requestHeaders,
            body: JSON.stringify(requestBody),
        });
    }
    catch (err) {
        console.error(`[qqbot-api:${appId}] <<< Network error:`, err);
        throw new Error(`Network error getting access_token: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 打印响应头
    const responseHeaders = {};
    response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
    });
    console.log(`[qqbot-api:${appId}] <<< Status: ${response.status} ${response.statusText}`);
    let data;
    let rawBody;
    try {
        rawBody = await response.text();
        // 隐藏 token 值
        const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"');
        console.log(`[qqbot-api:${appId}] <<< Body:`, logBody);
        data = JSON.parse(rawBody);
    }
    catch (err) {
        console.error(`[qqbot-api:${appId}] <<< Parse error:`, err);
        throw new Error(`Failed to parse access_token response: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!data.access_token) {
        throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
    }
    const expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
    tokenCacheMap.set(appId, {
        token: data.access_token,
        expiresAt,
        appId,
    });
    console.log(`[qqbot-api:${appId}] Token cached, expires at: ${new Date(expiresAt).toISOString()}`);
    return data.access_token;
}
/**
 * 清除 Token 缓存
 * @param appId 选填。如果有，只清空特定账号的缓存；如果没有，清空所有账号。
 */
export function clearTokenCache(appId) {
    if (appId) {
        tokenCacheMap.delete(appId);
        console.log(`[qqbot-api:${appId}] Token cache cleared manually.`);
    }
    else {
        tokenCacheMap.clear();
        console.log(`[qqbot-api] All token caches cleared.`);
    }
}
/**
 * 获取 Token 缓存状态（用于监控）
 */
export function getTokenStatus(appId) {
    if (tokenFetchPromises.has(appId)) {
        return { status: "refreshing", expiresAt: tokenCacheMap.get(appId)?.expiresAt ?? null };
    }
    const cached = tokenCacheMap.get(appId);
    if (!cached) {
        return { status: "none", expiresAt: null };
    }
    const isValid = Date.now() < cached.expiresAt - 5 * 60 * 1000;
    return { status: isValid ? "valid" : "expired", expiresAt: cached.expiresAt };
}
/**
 * 获取全局唯一的消息序号（范围 0 ~ 65535）
 * 使用毫秒级时间戳低位 + 随机数异或混合，无状态，避免碰撞
 */
export function getNextMsgSeq(_msgId) {
    const timePart = Date.now() % 100000000; // 毫秒时间戳后8位
    const random = Math.floor(Math.random() * 65536); // 0~65535
    return (timePart ^ random) % 65536; // 异或混合后限制在 0~65535
}
// API 请求超时配置（毫秒）
const DEFAULT_API_TIMEOUT = 30000; // 默认 30 秒
const FILE_UPLOAD_TIMEOUT = 120000; // 文件上传 120 秒
/**
 * API 请求封装
 */
export async function apiRequest(accessToken, method, path, body, timeoutMs) {
    const url = `${API_BASE}${path}`;
    const headers = {
        Authorization: `QQBot ${accessToken}`,
        "Content-Type": "application/json",
    };
    const isFileUpload = path.includes("/files");
    const timeout = timeoutMs ?? (isFileUpload ? FILE_UPLOAD_TIMEOUT : DEFAULT_API_TIMEOUT);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
    }, timeout);
    const options = {
        method,
        headers,
        signal: controller.signal,
    };
    if (body) {
        options.body = JSON.stringify(body);
    }
    // 打印请求信息
    console.log(`[qqbot-api] >>> ${method} ${url} (timeout: ${timeout}ms)`);
    if (body) {
        const logBody = { ...body };
        if (typeof logBody.file_data === "string") {
            logBody.file_data = `<base64 ${logBody.file_data.length} chars>`;
        }
    }
    let res;
    try {
        res = await fetch(url, options);
    }
    catch (err) {
        clearTimeout(timeoutId);
        if (err instanceof Error && err.name === "AbortError") {
            console.error(`[qqbot-api] <<< Request timeout after ${timeout}ms`);
            throw new Error(`Request timeout[${path}]: exceeded ${timeout}ms`);
        }
        console.error(`[qqbot-api] <<< Network error:`, err);
        throw new Error(`Network error [${path}]: ${err instanceof Error ? err.message : String(err)}`);
    }
    finally {
        clearTimeout(timeoutId);
    }
    const responseHeaders = {};
    res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
    });
    console.log(`[qqbot-api] <<< Status: ${res.status} ${res.statusText}`);
    let data;
    let rawBody;
    try {
        rawBody = await res.text();
        data = JSON.parse(rawBody);
    }
    catch (err) {
        throw new Error(`Failed to parse response[${path}]: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
        const error = data;
        throw new Error(`API Error [${path}]: ${error.message ?? JSON.stringify(data)}`);
    }
    return data;
}
// ============ 上传重试（指数退避） ============
const UPLOAD_MAX_RETRIES = 2;
const UPLOAD_BASE_DELAY_MS = 1000;
async function apiRequestWithRetry(accessToken, method, path, body, maxRetries = UPLOAD_MAX_RETRIES) {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await apiRequest(accessToken, method, path, body);
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            const errMsg = lastError.message;
            if (errMsg.includes("400") || errMsg.includes("401") || errMsg.includes("Invalid") ||
                errMsg.includes("上传超时") || errMsg.includes("timeout") || errMsg.includes("Timeout")) {
                throw lastError;
            }
            if (attempt < maxRetries) {
                const delay = UPLOAD_BASE_DELAY_MS * Math.pow(2, attempt);
                console.log(`[qqbot-api] Upload attempt ${attempt + 1} failed, retrying in ${delay}ms: ${errMsg.slice(0, 100)}`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}
export async function getGatewayUrl(accessToken) {
    const data = await apiRequest(accessToken, "GET", "/gateway");
    return data.url;
}
function buildMessageBody(content, msgId, msgSeq) {
    const body = currentMarkdownSupport
        ? {
            markdown: { content },
            msg_type: 2,
            msg_seq: msgSeq,
        }
        : {
            content,
            msg_type: 0,
            msg_seq: msgSeq,
        };
    if (msgId) {
        body.msg_id = msgId;
    }
    return body;
}
export async function sendC2CMessage(accessToken, openid, content, msgId) {
    const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
    const body = buildMessageBody(content, msgId, msgSeq);
    return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body);
}
export async function sendC2CInputNotify(accessToken, openid, msgId, inputSecond = 60) {
    const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
    const body = {
        msg_type: 6,
        input_notify: {
            input_type: 1,
            input_second: inputSecond,
        },
        msg_seq: msgSeq,
        ...(msgId ? { msg_id: msgId } : {}),
    };
    await apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body);
}
export async function sendChannelMessage(accessToken, channelId, content, msgId) {
    return apiRequest(accessToken, "POST", `/channels/${channelId}/messages`, {
        content,
        ...(msgId ? { msg_id: msgId } : {}),
    });
}
export async function sendGroupMessage(accessToken, groupOpenid, content, msgId) {
    const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
    const body = buildMessageBody(content, msgId, msgSeq);
    return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body);
}
function buildProactiveMessageBody(content) {
    if (!content || content.trim().length === 0) {
        throw new Error("主动消息内容不能为空 (markdown.content is empty)");
    }
    if (currentMarkdownSupport) {
        return { markdown: { content }, msg_type: 2 };
    }
    else {
        return { content, msg_type: 0 };
    }
}
export async function sendProactiveC2CMessage(accessToken, openid, content) {
    const body = buildProactiveMessageBody(content);
    return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body);
}
export async function sendProactiveGroupMessage(accessToken, groupOpenid, content) {
    const body = buildProactiveMessageBody(content);
    return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body);
}
// ============ 富媒体消息支持 ============
export var MediaFileType;
(function (MediaFileType) {
    MediaFileType[MediaFileType["IMAGE"] = 1] = "IMAGE";
    MediaFileType[MediaFileType["VIDEO"] = 2] = "VIDEO";
    MediaFileType[MediaFileType["VOICE"] = 3] = "VOICE";
    MediaFileType[MediaFileType["FILE"] = 4] = "FILE";
})(MediaFileType || (MediaFileType = {}));
export async function uploadC2CMedia(accessToken, openid, fileType, url, fileData, srvSendMsg = false, fileName) {
    if (!url && !fileData)
        throw new Error("uploadC2CMedia: url or fileData is required");
    if (fileData) {
        const contentHash = computeFileHash(fileData);
        const cachedInfo = getCachedFileInfo(contentHash, "c2c", openid, fileType);
        if (cachedInfo) {
            return { file_uuid: "", file_info: cachedInfo, ttl: 0 };
        }
    }
    const body = { file_type: fileType, srv_send_msg: srvSendMsg };
    if (url)
        body.url = url;
    else if (fileData)
        body.file_data = fileData;
    if (fileType === MediaFileType.FILE && fileName)
        body.file_name = sanitizeFileName(fileName);
    const result = await apiRequestWithRetry(accessToken, "POST", `/v2/users/${openid}/files`, body);
    if (fileData && result.file_info && result.ttl > 0) {
        const contentHash = computeFileHash(fileData);
        setCachedFileInfo(contentHash, "c2c", openid, fileType, result.file_info, result.file_uuid, result.ttl);
    }
    return result;
}
export async function uploadGroupMedia(accessToken, groupOpenid, fileType, url, fileData, srvSendMsg = false, fileName) {
    if (!url && !fileData)
        throw new Error("uploadGroupMedia: url or fileData is required");
    if (fileData) {
        const contentHash = computeFileHash(fileData);
        const cachedInfo = getCachedFileInfo(contentHash, "group", groupOpenid, fileType);
        if (cachedInfo) {
            return { file_uuid: "", file_info: cachedInfo, ttl: 0 };
        }
    }
    const body = { file_type: fileType, srv_send_msg: srvSendMsg };
    if (url)
        body.url = url;
    else if (fileData)
        body.file_data = fileData;
    if (fileType === MediaFileType.FILE && fileName)
        body.file_name = sanitizeFileName(fileName);
    const result = await apiRequestWithRetry(accessToken, "POST", `/v2/groups/${groupOpenid}/files`, body);
    if (fileData && result.file_info && result.ttl > 0) {
        const contentHash = computeFileHash(fileData);
        setCachedFileInfo(contentHash, "group", groupOpenid, fileType, result.file_info, result.file_uuid, result.ttl);
    }
    return result;
}
export async function sendC2CMediaMessage(accessToken, openid, fileInfo, msgId, content) {
    const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
    return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, {
        msg_type: 7,
        media: { file_info: fileInfo },
        msg_seq: msgSeq,
        ...(content ? { content } : {}),
        ...(msgId ? { msg_id: msgId } : {}),
    });
}
export async function sendGroupMediaMessage(accessToken, groupOpenid, fileInfo, msgId, content) {
    const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
    return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, {
        msg_type: 7,
        media: { file_info: fileInfo },
        msg_seq: msgSeq,
        ...(content ? { content } : {}),
        ...(msgId ? { msg_id: msgId } : {}),
    });
}
export async function sendC2CImageMessage(accessToken, openid, imageUrl, msgId, content) {
    let uploadResult;
    if (imageUrl.startsWith("data:")) {
        const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!matches)
            throw new Error("Invalid Base64 Data URL format");
        uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.IMAGE, undefined, matches[2], false);
    }
    else {
        uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.IMAGE, imageUrl, undefined, false);
    }
    return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, content);
}
export async function sendGroupImageMessage(accessToken, groupOpenid, imageUrl, msgId, content) {
    let uploadResult;
    if (imageUrl.startsWith("data:")) {
        const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
        if (!matches)
            throw new Error("Invalid Base64 Data URL format");
        uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.IMAGE, undefined, matches[2], false);
    }
    else {
        uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.IMAGE, imageUrl, undefined, false);
    }
    return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}
export async function sendC2CVoiceMessage(accessToken, openid, voiceBase64, msgId) {
    const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.VOICE, undefined, voiceBase64, false);
    return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId);
}
export async function sendGroupVoiceMessage(accessToken, groupOpenid, voiceBase64, msgId) {
    const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.VOICE, undefined, voiceBase64, false);
    return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId);
}
export async function sendC2CFileMessage(accessToken, openid, fileBase64, fileUrl, msgId, fileName) {
    const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.FILE, fileUrl, fileBase64, false, fileName);
    return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId);
}
export async function sendGroupFileMessage(accessToken, groupOpenid, fileBase64, fileUrl, msgId, fileName) {
    const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.FILE, fileUrl, fileBase64, false, fileName);
    return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId);
}
export async function sendC2CVideoMessage(accessToken, openid, videoUrl, videoBase64, msgId, content) {
    const uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.VIDEO, videoUrl, videoBase64, false);
    return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, content);
}
export async function sendGroupVideoMessage(accessToken, groupOpenid, videoUrl, videoBase64, msgId, content) {
    const uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.VIDEO, videoUrl, videoBase64, false);
    return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content);
}
const backgroundRefreshControllers = new Map();
export function startBackgroundTokenRefresh(appId, clientSecret, options) {
    if (backgroundRefreshControllers.has(appId)) {
        console.log(`[qqbot-api:${appId}] Background token refresh already running`);
        return;
    }
    const { refreshAheadMs = 5 * 60 * 1000, randomOffsetMs = 30 * 1000, minRefreshIntervalMs = 60 * 1000, retryDelayMs = 5 * 1000, log, } = options ?? {};
    const controller = new AbortController();
    backgroundRefreshControllers.set(appId, controller);
    const signal = controller.signal;
    const refreshLoop = async () => {
        log?.info?.(`[qqbot-api:${appId}] Background token refresh started`);
        while (!signal.aborted) {
            try {
                await getAccessToken(appId, clientSecret);
                const cached = tokenCacheMap.get(appId);
                if (cached) {
                    const expiresIn = cached.expiresAt - Date.now();
                    const randomOffset = Math.random() * randomOffsetMs;
                    const refreshIn = Math.max(expiresIn - refreshAheadMs - randomOffset, minRefreshIntervalMs);
                    log?.debug?.(`[qqbot-api:${appId}] Token valid, next refresh in ${Math.round(refreshIn / 1000)}s`);
                    await sleep(refreshIn, signal);
                }
                else {
                    log?.debug?.(`[qqbot-api:${appId}] No cached token, retrying soon`);
                    await sleep(minRefreshIntervalMs, signal);
                }
            }
            catch (err) {
                if (signal.aborted)
                    break;
                log?.error?.(`[qqbot-api:${appId}] Background token refresh failed: ${err}`);
                await sleep(retryDelayMs, signal);
            }
        }
        backgroundRefreshControllers.delete(appId);
        log?.info?.(`[qqbot-api:${appId}] Background token refresh stopped`);
    };
    refreshLoop().catch((err) => {
        backgroundRefreshControllers.delete(appId);
        log?.error?.(`[qqbot-api:${appId}] Background token refresh crashed: ${err}`);
    });
}
/**
 * 停止后台 Token 刷新
 * @param appId 选填。如果有，仅停止该账号的定时刷新。
 */
export function stopBackgroundTokenRefresh(appId) {
    if (appId) {
        const controller = backgroundRefreshControllers.get(appId);
        if (controller) {
            controller.abort();
            backgroundRefreshControllers.delete(appId);
        }
    }
    else {
        for (const controller of backgroundRefreshControllers.values()) {
            controller.abort();
        }
        backgroundRefreshControllers.clear();
    }
}
export function isBackgroundTokenRefreshRunning(appId) {
    if (appId)
        return backgroundRefreshControllers.has(appId);
    return backgroundRefreshControllers.size > 0;
}
async function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        if (signal) {
            if (signal.aborted) {
                clearTimeout(timer);
                reject(new Error("Aborted"));
                return;
            }
            const onAbort = () => {
                clearTimeout(timer);
                reject(new Error("Aborted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
        }
    });
}
