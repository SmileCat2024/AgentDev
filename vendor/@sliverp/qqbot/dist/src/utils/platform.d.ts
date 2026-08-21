/**
 * 跨平台兼容工具
 *
 * 统一 Mac / Linux / Windows 三大系统的：
 * - 用户主目录获取
 * - 临时目录获取
 * - 本地路径判断
 * - ffmpeg / ffprobe 可执行文件路径
 * - silk-wasm 原生模块兼容性检测
 * - 启动诊断报告
 */
export type PlatformType = "darwin" | "linux" | "win32" | "other";
export declare function getPlatform(): PlatformType;
export declare function isWindows(): boolean;
/**
 * 安全获取用户主目录
 *
 * 优先级:
 * 1. os.homedir()（Node 原生，所有平台）
 * 2. $HOME（Mac/Linux）或 %USERPROFILE%（Windows）
 * 3. 降级到 /tmp（Linux/Mac）或 os.tmpdir()（Windows）
 *
 * 与之前 `process.env.HOME || "/home/ubuntu"` 的硬编码相比，
 * 现在能正确处理 Windows 和非 ubuntu 用户。
 */
export declare function getHomeDir(): string;
/**
 * 获取 .openclaw/qqbot 下的子目录路径，并自动创建
 * 替代各文件中分散的 path.join(HOME, ".openclaw", "qqbot", ...)
 */
export declare function getQQBotDataDir(...subPaths: string[]): string;
/**
 * 获取系统临时目录（跨平台安全）
 * Mac: /var/folders/... 或 /tmp
 * Linux: /tmp
 * Windows: %TEMP% 或 C:\Users\xxx\AppData\Local\Temp
 */
export declare function getTempDir(): string;
/**
 * 展开路径中的波浪线（~）为用户主目录
 *
 * Mac/Linux 用户经常使用 `~/Desktop/file.png` 这样的路径，
 * 但 Node.js 的 fs 模块不会像 shell 一样自动展开 `~`。
 *
 * 支持:
 * - `~/xxx`  → `/Users/you/xxx`（Mac）或 `/home/you/xxx`（Linux）
 * - `~`      → `/Users/you`
 * - 非 `~` 开头的路径原样返回
 *
 * 注意: 不支持 `~otheruser/xxx` 语法（极少使用，且需要系统调用获取其他用户信息）
 */
export declare function expandTilde(p: string): string;
/**
 * 对路径进行完整的规范化处理：展开波浪线 + 去除首尾空白
 * 所有文件操作前应通过此函数处理用户输入的路径
 */
export declare function normalizePath(p: string): string;
/**
 * 规范化文件名为 QQ Bot API 要求的 UTF-8 编码格式
 *
 * 问题场景:
 * - macOS HFS+/APFS 文件系统使用 NFD（Unicode 分解形式）存储文件名，
 *   例如「中文.txt」被分解为多个码点，QQ Bot API 可能拒绝
 * - 文件名可能包含 API 不接受的特殊控制字符
 * - URL 路径中可能包含 percent-encoded 的文件名需要解码
 *
 * 处理:
 * 1. Unicode NFC 规范化（将 NFD 分解形式合并为 NFC 组合形式）
 * 2. 去除 ASCII 控制字符（0x00-0x1F, 0x7F）
 * 3. 去除首尾空白
 * 4. 对 percent-encoded 的文件名尝试 URI 解码
 */
export declare function sanitizeFileName(name: string): string;
/**
 * 判断字符串是否为本地文件路径（非 URL）
 *
 * 覆盖:
 * - Unix 绝对路径: /Users/..., /home/..., /tmp/...
 * - Windows 绝对路径: C:\..., D:/..., \\server\share
 * - 相对路径: ./file, ../file
 * - 波浪线路径: ~/Desktop/file.png
 *
 * 不匹配:
 * - http:// / https:// URL
 * - data: URL
 */
export declare function isLocalPath(p: string): boolean;
/**
 * 判断 markdown 中提取的路径是否像本地路径
 * 比 isLocalPath 更宽松，用于从 markdown ![](path) 中检测误用
 */
export declare function looksLikeLocalPath(p: string): boolean;
/**
 * 检测 ffmpeg 是否可用，返回可执行路径
 *
 * Windows 上检测 ffmpeg.exe，Mac/Linux 检测 ffmpeg
 * 支持通过环境变量 FFMPEG_PATH 指定自定义路径
 *
 * @returns ffmpeg 可执行文件路径，不可用返回 null
 */
export declare function detectFfmpeg(): Promise<string | null>;
/** 重置 ffmpeg 缓存（用于测试） */
export declare function resetFfmpegCache(): void;
/**
 * 检测 silk-wasm 是否可用
 *
 * silk-wasm 依赖 WASM 运行时，在某些环境（如老版本 Node、某些容器）可能不可用。
 * 提前检测避免运行时崩溃。
 */
export declare function checkSilkWasmAvailable(): Promise<boolean>;
export interface DiagnosticReport {
    platform: string;
    arch: string;
    nodeVersion: string;
    homeDir: string;
    tempDir: string;
    dataDir: string;
    ffmpeg: string | null;
    silkWasm: boolean;
    warnings: string[];
}
/**
 * 运行启动诊断，返回环境报告
 * 在 gateway 启动时调用，打印环境信息并给出警告
 */
export declare function runDiagnostics(): Promise<DiagnosticReport>;
