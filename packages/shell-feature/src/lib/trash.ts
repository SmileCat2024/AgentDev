/**
 * SafeRm - 安全删除核心逻辑
 */

import { join, resolve } from 'path';
import { cwd } from 'process';
import { FileSystem } from './fs.js';
import { validateOperator, generateTrashName, createTrashInfo, parseRmCommand } from './trashinfo.js';
import {
  SafeRmError,
  throwNoFilesSpecifiedError,
  throwFileNotFoundError,
} from './errors.js';
import { ErrorCode, Mode, TrashResult, type SafeRmOptions, type SafeRmResult } from './types.js';

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
    validateOperator(this.operator);
    this._ensureTrashDir();
  }

  private _ensureTrashDir(): void {
    const parentDir = join(this.trashDir, '..');
    if (!FileSystem.exists(parentDir)) {
      throw new SafeRmError(ErrorCode.ERROR_NO_TRASH_DIR, '垃圾目录的父目录不存在', { trash_dir: this.trashDir, parent_dir: parentDir });
    }
    FileSystem.makedirs(this.trashDir);
    FileSystem.makedirs(join(this.trashDir, 'info'));
    FileSystem.makedirs(join(this.trashDir, 'files'));

    const testFile = join(this.trashDir, 'info', '.write_test');
    try {
      FileSystem.writeFile(testFile, 'test');
      FileSystem.remove(testFile);
    } catch {
      throw new SafeRmError(ErrorCode.ERROR_TRASH_NOT_WRITABLE, '垃圾目录不可写', { trash_dir: this.trashDir });
    }
  }

  trashSingle(path: string, mode: Mode): TrashResult {
    FileSystem.validatePath(path);
    if (FileSystem.shouldSkipBySpecs(path)) return TrashResult.FAILURE;

    const absPath = resolve(path);
    if (FileSystem.isSystemFile(absPath)) {
      throw new SafeRmError(ErrorCode.ERROR_SYSTEM_FILE, '系统文件受保护，无法删除', { path });
    }

    if (!FileSystem.lexists(path)) {
      if (mode === Mode.MODE_FORCE) return TrashResult.SUCCESS;
      throwFileNotFoundError(path);
    }

    try {
      const trashName = generateTrashName(path);
      const destPath = join(this.trashDir, 'files', trashName);
      createTrashInfo(path, trashName, this.trashDir, this.operator);
      FileSystem.move(path, destPath);
      return TrashResult.SUCCESS;
    } catch (error) {
      if (error instanceof SafeRmError) throw error;
      throw new SafeRmError(ErrorCode.ERROR_UNKNOWN, `删除文件失败: ${error instanceof Error ? error.message : String(error)}`, { path });
    }
  }

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

export function safeRm(
  workingDir: string | null,
  rmCommand: string,
  trashDir: string,
  operator: string | null = null,
  verbose: number = 0
): SafeRmResult {
  validateOperator(operator);
  const { files, force, interactive } = parseRmCommand(rmCommand);

  if (files.length === 0) throwNoFilesSpecifiedError();

  let mode: Mode;
  if (force) mode = Mode.MODE_FORCE;
  else if (interactive) mode = Mode.MODE_INTERACTIVE;
  else mode = Mode.MODE_UNSPECIFIED;

  let originalDir: string | null = null;
  if (workingDir) {
    if (!FileSystem.exists(workingDir)) {
      throw new SafeRmError(ErrorCode.ERROR_WORKING_DIR_NOT_FOUND, '工作目录不存在', { working_dir: workingDir });
    }
    originalDir = cwd();
    process.chdir(workingDir);
  }

  try {
    const safeRmInstance = new SafeRm({ trashDir, workingDir, operator, verbose });
    return safeRmInstance.trashAll(files, mode);
  } finally {
    if (originalDir !== null) process.chdir(originalDir);
  }
}
