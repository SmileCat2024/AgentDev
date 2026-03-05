/**
 * Safe Trash 错误处理
 *
 * 复刻自 safe_rm.py 的错误系统
 */

import { ErrorCode } from './types.js';

/**
 * 自定义错误类
 */
export class SafeRmError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'SafeRmError';
    this.code = code;
    this.details = details || {};
  }

  /**
   * 转换为字典（用于 JSON 输出）
   */
  toDict(): Record<string, unknown> {
    return {
      success: false,
      error_code: this.code,
      error_message: this.message,
      error_details: this.details,
    };
  }

  /**
   * 转换为 SafeRmResult 格式
   */
  toSafeRmResult(): import('./types.js').SafeRmResult {
    return {
      success: false,
      moved: [],
      failed: [this.message],
      movedCount: 0,
      failedCount: 1,
    };
  }
}

/**
 * 创建并抛出路径错误
 */
export function throwInvalidPathError(path: string): never {
  throw new SafeRmError(
    ErrorCode.ERROR_INVALID_PATH,
    '路径无效',
    { path }
  );
}

/**
 * 创建并抛出路径过长错误
 */
export function throwPathTooLongError(path: string, length: number, max: number): never {
  throw new SafeRmError(
    ErrorCode.ERROR_PATH_TOO_LONG,
    `路径过长（最大 ${max} 字符）`,
    { path, length, max_length: max }
  );
}

/**
 * 创建并抛出非法字符错误
 */
export function throwIllegalCharError(path: string, char: string): never {
  throw new SafeRmError(
    ErrorCode.ERROR_INVALID_PATH,
    `路径包含非法字符: '${char}'`,
    { path, illegal_char: char }
  );
}

/**
 * 创建并抛出文件不存在错误
 */
export function throwFileNotFoundError(path: string): never {
  throw new SafeRmError(
    ErrorCode.ERROR_FILE_NOT_FOUND,
    '文件不存在',
    { path }
  );
}

/**
 * 创建并抛出权限拒绝错误
 */
export function throwPermissionDeniedError(path: string, action: string): never {
  throw new SafeRmError(
    ErrorCode.ERROR_PERMISSION_DENIED,
    `权限不足，无法${action}`,
    { path }
  );
}

/**
 * 创建并抛出系统文件错误
 */
export function throwSystemFileError(path: string): never {
  throw new SafeRmError(
    ErrorCode.ERROR_SYSTEM_FILE,
    '系统文件受保护，无法删除',
    { path }
  );
}

/**
 * 创建并抛出文件已存在错误
 */
export function throwFileExistsError(path: string): never {
  throw new SafeRmError(
    ErrorCode.ERROR_FILE_EXISTS,
    '文件已存在',
    { path }
  );
}

/**
 * 创建并抛出垃圾目录错误
 */
export function throwNoTrashDirError(trashDir: string): never {
  throw new SafeRmError(
    ErrorCode.ERROR_NO_TRASH_DIR,
    '垃圾目录不存在',
    { trash_dir: trashDir }
  );
}

/**
 * 创建并抛出操作者名称错误
 */
export function throwInvalidOperatorError(operator: string): never {
  throw new SafeRmError(
    ErrorCode.ERROR_INVALID_OPERATOR,
    '操作者名称无效',
    { operator }
  );
}

/**
 * 创建并抛出未指定文件错误
 */
export function throwNoFilesSpecifiedError(): never {
  throw new SafeRmError(
    ErrorCode.ERROR_NO_FILES_SPECIFIED,
    '请指定要删除的文件',
    {}
  );
}
