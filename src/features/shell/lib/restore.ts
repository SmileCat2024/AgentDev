/**
 * SafeRestore - 安全恢复核心逻辑
 *
 * 复刻自 safe_rm.py 的 SafeRestore 类
 */

import { join, resolve, dirname } from 'path';
import { FileSystem } from './fs.js';
import { validateOperator, parseTrashInfo } from './trashinfo.js';
import { SafeRmError, throwFileExistsError, throwNoTrashDirError } from './errors.js';
import { ErrorCode, RestoreOptions, RestoreTarget, RestoreResult, ListResult } from './types.js';

/**
 * 通配符匹配
 */
function matchesPattern(actualPath: string, pattern: string): boolean {
  // 转换 glob 模式为正则表达式
  const regexPattern = pattern
    .replace(/\./g, '\\.')  // . 字面量
    .replace(/\*/g, '.*')   // * 任意字符
    .replace(/\?/g, '.')    // ? 单个字符
    .replace(/\[/g, '[')    // 保留字符类
    .replace(/\]/g, ']');

  const regex = new RegExp(`^${regexPattern}$`, 'i');

  // 尝试匹配原始路径和 Windows 路径
  return regex.test(actualPath) || regex.test(actualPath.replace(/\//g, '\\'));
}

/**
 * 解析索引规格（如 "0-3,5"）
 */
function parseIndexSpec(spec: string): number[] {
  const indices: number[] = [];

  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      // 范围
      const [startStr, endStr] = trimmed.split('-', 2);
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (isNaN(start) || isNaN(end)) {
        throw new SafeRmError(
          ErrorCode.ERROR_INVALID_INDEX,
          `无效的索引范围: ${trimmed}`,
          { spec }
        );
      }

      for (let i = start; i <= end; i++) {
        indices.push(i);
      }
    } else {
      // 单个索引
      const index = parseInt(trimmed, 10);
      if (isNaN(index)) {
        throw new SafeRmError(
          ErrorCode.ERROR_INVALID_INDEX,
          `无效的索引: ${trimmed}`,
          { spec }
        );
      }
      indices.push(index);
    }
  }

  return indices;
}

/**
 * SafeRestore 类 - 安全恢复核心
 */
export class SafeRestore {
  readonly trashDir: string;
  readonly operator: string | null;
  readonly verbose: number;

  constructor(options: RestoreOptions) {
    this.trashDir = resolve(options.trashDir);
    this.operator = options.operator || null;
    this.verbose = options.verbose || 0;

    // 验证操作者
    validateOperator(this.operator);

    // 验证垃圾目录
    if (!FileSystem.exists(this.trashDir)) {
      throwNoTrashDirError(this.trashDir);
    }
  }

  /**
   * 扫描所有 .trashinfo 文件
   */
  private _scanInfoFiles(): import('./types.js').TrashedFileInfo[] {
    const infoDir = join(this.trashDir, 'info');
    const files: import('./types.js').TrashedFileInfo[] = [];

    if (!FileSystem.exists(infoDir)) {
      return files;
    }

    const entries = FileSystem.listDir(infoDir);

    for (const filename of entries) {
      if (!filename.endsWith('.trashinfo')) {
        continue;
      }

      const infoPath = join(infoDir, filename);
      const info = parseTrashInfo(infoPath, this.trashDir);

      if (info) {
        // 按操作者过滤
        if (this.operator === null || info.operator === this.operator) {
          files.push(info);
        }
      }
    }

    return files;
  }

  /**
   * 列出所有可恢复的文件
   */
  listTrashed(): import('./types.js').TrashedFileInfo[] {
    const files = this._scanInfoFiles();
    // 按删除日期排序
    files.sort((a, b) => a.deletionDate.localeCompare(b.deletionDate));
    // 更新索引
    for (let i = 0; i < files.length; i++) {
      files[i] = { ...files[i], index: i };
    }
    return files;
  }

  /**
   * 检查文件是否匹配目标
   */
  private _matchesTarget(
    info: import('./types.js').TrashedFileInfo,
    target: number | string
  ): boolean {
    if (typeof target === 'number') {
      return info.index === target;
    } else {
      // 字符串模式匹配
      return matchesPattern(info.originalPath, target) ||
             matchesPattern(info.originalPath.replace(/\//g, '\\'), target);
    }
  }

  /**
   * 恢复文件
   */
  restore(
    target: RestoreTarget,
    overwrite: boolean = false,
    dryRun: boolean = false
  ): RestoreResult {
    const allFiles = this.listTrashed();
    const restored: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    const skipped: string[] = [];

    // 确定要恢复的文件
    const targets: Array<number | string> = Array.isArray(target)
      ? target
      : [target];

    // 找到匹配的文件
    const filesToRestore = new Set<import('./types.js').TrashedFileInfo>();

    for (const t of targets) {
      let matched = false;
      for (const info of allFiles) {
        if (this._matchesTarget(info, t)) {
          filesToRestore.add(info);
          matched = true;
        }
      }
      if (!matched && typeof t === 'number') {
        failed.push({
          path: `index:${t}`,
          error: '索引没有找到对应的文件',
        });
      }
    }

    // 执行恢复
    for (const info of Array.from(filesToRestore)) {
      try {
        // 检查目标位置是否已存在
        if (FileSystem.exists(info.originalPath)) {
          if (!overwrite) {
            failed.push({
              path: info.originalPath,
              error: 'file already exists',
            });
            continue;
          }
        }

        // 创建父目录
        const parentDir = dirname(info.originalPath);
        if (parentDir && !FileSystem.exists(parentDir)) {
          FileSystem.makedirs(parentDir);
        }

        if (dryRun) {
          restored.push(info.originalPath);
        } else {
          // 移动文件
          FileSystem.move(info.trashFile, info.originalPath);
          // 删除 .trashinfo
          FileSystem.remove(info.infoFile);
          restored.push(info.originalPath);
        }
      } catch (error) {
        failed.push({
          path: info.originalPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      success: failed.length === 0,
      restored,
      failed,
      skipped,
      restoredCount: restored.length,
      failedCount: failed.length,
      skippedCount: skipped.length,
    };
  }
}

/**
 * list_trashed API 函数
 */
export function listTrashed(
  trashDir: string,
  operator: string | null = null
): ListResult {
  validateOperator(operator);

  const restorer = new SafeRestore({
    trashDir,
    operator,
  });

  const infoList = restorer.listTrashed();

  return {
    success: true,
    total: infoList.length,
    files: infoList,
  };
}

/**
 * restore API 函数
 */
export function restore(
  trashDir: string,
  target: RestoreTarget,
  operator: string | null = null,
  overwrite: boolean = false,
  dryRun: boolean = false,
  parseIndexRanges: boolean = true
): RestoreResult {
  validateOperator(operator);

  const restorer = new SafeRestore({
    trashDir,
    operator,
  });

  // 解析索引范围
  let actualTarget: RestoreTarget = target;
  if (parseIndexRanges && typeof target === 'string') {
    // 检查是否为纯数字索引规格
    if (/^[\d,\s\-]+$/.test(target.trim())) {
      try {
        actualTarget = parseIndexSpec(target);
      } catch {
        // 如果解析失败，保持原样（可能是路径模式）
        actualTarget = target;
      }
    }
  }

  return restorer.restore(actualTarget, overwrite, dryRun);
}
