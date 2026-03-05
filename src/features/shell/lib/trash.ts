/**
 * SafeRm - 安全删除核心逻辑
 *
 * 复刻自 safe_rm.py 的 SafeRm 类
 */

import { join, resolve } from 'path';
import { cwd } from 'process';
import { FileSystem } from './fs.js';
import {
  validateOperator,
  generateTrashName,
  createTrashInfo,
  parseRmCommand,
} from './trashinfo.js';
import {
  SafeRmError,
  throwNoTrashDirError,
  throwNoFilesSpecifiedError,
  throwFileNotFoundError,
  throwPermissionDeniedError,
} from './errors.js';
import { ErrorCode, Mode, TrashResult, SafeRmOptions, SafeRmResult } from './types.js';

/**
 * SafeRm 类 - 安全删除核心
 */
export class SafeRm {
  readonly trashDir: string;
  readonly workingDir: string | null;
  readonly operator: string | null;
  readonly verbose: number;

  constructor(options: SafeRmOptions) {
    this.trashDir = resolve(options.trashDir);
    this.workingDir = options.workingDir || null;
    this.operator = options.operator || null;
    this.verbose = options.verbose || 0;

    // 验证操作者
    validateOperator(this.operator);

    // 验证并创建垃圾目录
    this._ensureTrashDir();
  }

  /**
   * 确保垃圾目录存在并可写
   */
  private _ensureTrashDir(): void {
    // 检查父目录是否存在
    const parentDir = join(this.trashDir, '..');
    if (!FileSystem.exists(parentDir)) {
      throw new SafeRmError(
        ErrorCode.ERROR_NO_TRASH_DIR,
        '垃圾目录的父目录不存在',
        { trash_dir: this.trashDir, parent_dir: parentDir }
      );
    }

    // 创建目录结构
    FileSystem.makedirs(this.trashDir);
    FileSystem.makedirs(join(this.trashDir, 'info'));
    FileSystem.makedirs(join(this.trashDir, 'files'));

    // 检查是否可写（通过尝试创建临时文件）
    const testFile = join(this.trashDir, 'info', '.write_test');
    try {
      FileSystem.writeFile(testFile, 'test');
      FileSystem.remove(testFile);
    } catch {
      throw new SafeRmError(
        ErrorCode.ERROR_TRASH_NOT_WRITABLE,
        '垃圾目录不可写',
        { trash_dir: this.trashDir }
      );
    }
  }

  /**
   * 删除单个文件
   */
  trashSingle(path: string, mode: Mode): TrashResult {
    // 验证路径
    FileSystem.validatePath(path);

    // 检查特殊目录
    if (FileSystem.shouldSkipBySpecs(path)) {
      return TrashResult.FAILURE;
    }

    // 检查是否为系统文件
    const absPath = resolve(path);
    if (FileSystem.isSystemFile(absPath)) {
      throw new SafeRmError(
        ErrorCode.ERROR_SYSTEM_FILE,
        '系统文件受保护，无法删除',
        { path }
      );
    }

    // 检查文件是否存在
    if (!FileSystem.lexists(path)) {
      if (mode === Mode.MODE_FORCE) {
        return TrashResult.SUCCESS;
      }
      throwFileNotFoundError(path);
    }

    // 交互模式（Agent 场景不使用，但保留逻辑）
    if (mode === Mode.MODE_INTERACTIVE && FileSystem.exists(path)) {
      // 在 Agent 场景中，交互模式直接拒绝（需要用户确认）
      // 这里简化为直接继续
    }

    // 执行移动操作
    try {
      // 生成新的文件名
      const trashName = generateTrashName(path);

      // 目标路径
      const destPath = join(this.trashDir, 'files', trashName);

      // 创建 trashinfo
      createTrashInfo(path, trashName, this.trashDir, this.operator);

      // 移动文件
      FileSystem.move(path, destPath);

      return TrashResult.SUCCESS;
    } catch (error) {
      if (error instanceof SafeRmError) {
        throw error;
      }
      throw new SafeRmError(
        ErrorCode.ERROR_UNKNOWN,
        `删除文件失败: ${error instanceof Error ? error.message : String(error)}`,
        { path }
      );
    }
  }

  /**
   * 批量删除文件
   */
  trashAll(paths: string[], mode: Mode): SafeRmResult {
    const failedPaths: string[] = [];
    const movedPaths: string[] = [];

    for (const path of paths) {
      try {
        const result = this.trashSingle(path, mode);
        if (result === TrashResult.SUCCESS) {
          movedPaths.push(path);
        } else {
          failedPaths.push(path);
        }
      } catch {
        failedPaths.push(path);
      }
    }

    return {
      success: failedPaths.length === 0,
      moved: movedPaths,
      failed: failedPaths,
      movedCount: movedPaths.length,
      failedCount: failedPaths.length,
    };
  }
}

/**
 * safe_rm API 函数 - 从 rm 命令字符串执行删除
 */
export function safeRm(
  workingDir: string | null,
  rmCommand: string,
  trashDir: string,
  operator: string | null = null,
  verbose: number = 0
): SafeRmResult {
  // 验证操作者
  validateOperator(operator);

  // 解析命令
  const { files, force, interactive } = parseRmCommand(rmCommand);

  // 检查是否有文件要删除
  if (files.length === 0) {
    throwNoFilesSpecifiedError();
  }

  // 确定模式
  let mode: Mode;
  if (force) {
    mode = Mode.MODE_FORCE;
  } else if (interactive) {
    mode = Mode.MODE_INTERACTIVE;
  } else {
    mode = Mode.MODE_UNSPECIFIED;
  }

  // 处理工作目录
  let originalDir: string | null = null;
  if (workingDir) {
    if (!FileSystem.exists(workingDir)) {
      throw new SafeRmError(
        ErrorCode.ERROR_WORKING_DIR_NOT_FOUND,
        '工作目录不存在',
        { working_dir: workingDir }
      );
    }
    originalDir = cwd();
    process.chdir(workingDir);
  }

  try {
    const safeRmInstance = new SafeRm({
      trashDir,
      workingDir,
      operator,
      verbose,
    });

    return safeRmInstance.trashAll(files, mode);
  } finally {
    if (originalDir !== null) {
      process.chdir(originalDir);
    }
  }
}
