/**
 * Safe Trash 错误处理
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

  toDict(): Record<string, unknown> {
    return {
      success: false,
      error_code: this.code,
      error_message: this.message,
      error_details: this.details,
    };
  }

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

export function throwInvalidPathError(path: string): never {
  throw new SafeRmError(ErrorCode.ERROR_INVALID_PATH, '路径无效', { path });
}

export function throwPathTooLongError(path: string, length: number, max: number): never {
  throw new SafeRmError(ErrorCode.ERROR_PATH_TOO_LONG, `路径过长（最大 ${max} 字符）`, { path, length, max_length: max });
}

export function throwIllegalCharError(path: string, char: string): never {
  throw new SafeRmError(ErrorCode.ERROR_INVALID_PATH, `路径包含非法字符: '${char}'`, { path, illegal_char: char });
}

export function throwFileNotFoundError(path: string): never {
  throw new SafeRmError(ErrorCode.ERROR_FILE_NOT_FOUND, '文件不存在', { path });
}

export function throwPermissionDeniedError(path: string, action: string): never {
  throw new SafeRmError(ErrorCode.ERROR_PERMISSION_DENIED, `权限不足，无法${action}`, { path });
}

export function throwSystemFileError(path: string): never {
  throw new SafeRmError(ErrorCode.ERROR_SYSTEM_FILE, '系统文件受保护，无法删除', { path });
}

export function throwFileExistsError(path: string): never {
  throw new SafeRmError(ErrorCode.ERROR_FILE_EXISTS, '文件已存在', { path });
}

export function throwNoTrashDirError(trashDir: string): never {
  throw new SafeRmError(ErrorCode.ERROR_NO_TRASH_DIR, '垃圾目录不存在', { trash_dir: trashDir });
}

export function throwInvalidOperatorError(operator: string): never {
  throw new SafeRmError(ErrorCode.ERROR_INVALID_OPERATOR, '操作者名称无效', { operator });
}

export function throwNoFilesSpecifiedError(): never {
  throw new SafeRmError(ErrorCode.ERROR_NO_FILES_SPECIFIED, '请指定要删除的文件', {});
}
