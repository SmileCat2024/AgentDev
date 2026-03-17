/**
 * Safe Trash 类型定义
 */

/**
 * 错误码枚举
 */
export enum ErrorCode {
  SUCCESS = 'SUCCESS',
  ERROR_UNKNOWN = 'ERROR_UNKNOWN',
  ERROR_NO_TRASH_DIR = 'ERROR_NO_TRASH_DIR',
  ERROR_TRASH_NOT_WRITABLE = 'ERROR_TRASH_NOT_WRITABLE',
  ERROR_NO_SPACE = 'ERROR_NO_SPACE',
  ERROR_FILE_LOCKED = 'ERROR_FILE_LOCKED',
  ERROR_PATH_TOO_LONG = 'ERROR_PATH_TOO_LONG',
  ERROR_INVALID_OPERATOR = 'ERROR_INVALID_OPERATOR',
  ERROR_CORRUPT_INFO = 'ERROR_CORRUPT_INFO',
  ERROR_CREATE_PARENT_FAILED = 'ERROR_CREATE_PARENT_FAILED',
  ERROR_SYSTEM_FILE = 'ERROR_SYSTEM_FILE',
  ERROR_LINK_LOOP = 'ERROR_LINK_LOOP',
  ERROR_FILE_NOT_FOUND = 'ERROR_FILE_NOT_FOUND',
  ERROR_FILE_EXISTS = 'ERROR_FILE_EXISTS',
  ERROR_INVALID_PATH = 'ERROR_INVALID_PATH',
  ERROR_PERMISSION_DENIED = 'ERROR_PERMISSION_DENIED',
  ERROR_WORKING_DIR_NOT_FOUND = 'ERROR_WORKING_DIR_NOT_FOUND',
  ERROR_NO_FILES_SPECIFIED = 'ERROR_NO_FILES_SPECIFIED',
  ERROR_INVALID_INDEX = 'ERROR_INVALID_INDEX',
  ERROR_NO_MATCHING_FILES = 'ERROR_NO_MATCHING_FILES',
  ERROR_INTERACTIVE_CANCELLED = 'ERROR_INTERACTIVE_CANCELLED',
}

/**
 * 删除模式
 */
export enum Mode {
  MODE_UNSPECIFIED = 'mode_unspecified',
  MODE_INTERACTIVE = 'mode_interactive',
  MODE_FORCE = 'mode_force',
}

/**
 * 删除结果
 */
export enum TrashResult {
  FAILURE = 'Failure',
  SUCCESS = 'Success',
}

/**
 * 已删除文件的信息
 */
export interface TrashedFileInfo {
  index: number;
  originalPath: string;
  deletionDate: string;
  operator: string | null;
  trashFile: string;
  infoFile: string;
  size: number;
}

/**
 * 恢复结果
 */
export interface RestoreResult {
  success: boolean;
  restored: string[];
  failed: Array<{ path: string; error: string }>;
  skipped: string[];
  restoredCount: number;
  failedCount: number;
  skippedCount: number;
}

/**
 * 删除操作结果
 */
export interface SafeRmResult {
  success: boolean;
  moved: string[];
  failed: string[];
  movedCount: number;
  failedCount: number;
}

/**
 * 列表操作结果
 */
export interface ListResult {
  success: boolean;
  total: number;
  files: TrashedFileInfo[];
}

/**
 * SafeRm 配置选项
 */
export interface SafeRmOptions {
  trashDir: string;
  workingDir?: string | null;
  operator?: string | null;
  verbose?: number;
}

/**
 * Restore 配置选项
 */
export interface RestoreOptions {
  trashDir: string;
  operator?: string | null;
  verbose?: number;
}

/**
 * 恢复目标类型
 */
export type RestoreTarget = number | string | number[] | string[];

/**
 * 解析后的 rm 命令
 */
export interface ParsedRmCommand {
  files: string[];
  force: boolean;
  interactive: boolean;
  recursive: boolean;
}
