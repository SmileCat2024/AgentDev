/**
 * SafeRestore - 安全恢复核心逻辑
 */

import { join, resolve, dirname } from 'path';
import { FileSystem } from './fs.js';
import { validateOperator, parseTrashInfo } from './trashinfo.js';
import { SafeRmError, throwNoTrashDirError } from './errors.js';
import { ErrorCode, type RestoreOptions, type RestoreTarget, type RestoreResult, type ListResult, type TrashedFileInfo } from './types.js';

function matchesPattern(actualPath: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(actualPath) || regex.test(actualPath.replace(/\//g, '\\'));
}

function parseIndexSpec(spec: string): number[] {
  const indices: number[] = [];
  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-', 2);
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end)) {
        throw new SafeRmError(ErrorCode.ERROR_INVALID_INDEX, `无效的索引范围: ${trimmed}`, { spec });
      }
      for (let i = start; i <= end; i++) indices.push(i);
    } else {
      const index = parseInt(trimmed, 10);
      if (isNaN(index)) {
        throw new SafeRmError(ErrorCode.ERROR_INVALID_INDEX, `无效的索引: ${trimmed}`, { spec });
      }
      indices.push(index);
    }
  }
  return indices;
}

export class SafeRestore {
  readonly trashDir: string;
  readonly operator: string | null;
  readonly verbose: number;

  constructor(options: RestoreOptions) {
    this.trashDir = resolve(options.trashDir);
    this.operator = options.operator || null;
    this.verbose = options.verbose || 0;
    validateOperator(this.operator);
    if (!FileSystem.exists(this.trashDir)) throwNoTrashDirError(this.trashDir);
  }

  private _scanInfoFiles(): TrashedFileInfo[] {
    const infoDir = join(this.trashDir, 'info');
    const files: TrashedFileInfo[] = [];
    if (!FileSystem.exists(infoDir)) return files;

    const entries = FileSystem.listDir(infoDir);
    for (const filename of entries) {
      if (!filename.endsWith('.trashinfo')) continue;
      const infoPath = join(infoDir, filename);
      const info = parseTrashInfo(infoPath, this.trashDir);
      if (info && (this.operator === null || info.operator === this.operator)) {
        files.push(info);
      }
    }
    return files;
  }

  listTrashed(): TrashedFileInfo[] {
    const files = this._scanInfoFiles();
    files.sort((a, b) => a.deletionDate.localeCompare(b.deletionDate));
    for (let i = 0; i < files.length; i++) files[i] = { ...files[i], index: i };
    return files;
  }

  private _matchesTarget(info: TrashedFileInfo, target: number | string): boolean {
    if (typeof target === 'number') return info.index === target;
    return matchesPattern(info.originalPath, target) || matchesPattern(info.originalPath.replace(/\//g, '\\'), target);
  }

  restore(target: RestoreTarget, overwrite: boolean = false, dryRun: boolean = false): RestoreResult {
    const allFiles = this.listTrashed();
    const restored: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    const skipped: string[] = [];

    const targets: Array<number | string> = Array.isArray(target) ? target : [target];
    const filesToRestore = new Set<TrashedFileInfo>();

    for (const t of targets) {
      let matched = false;
      for (const info of allFiles) {
        if (this._matchesTarget(info, t)) {
          filesToRestore.add(info);
          matched = true;
        }
      }
      if (!matched && typeof t === 'number') {
        failed.push({ path: `index:${t}`, error: '索引没有找到对应的文件' });
      }
    }

    for (const info of Array.from(filesToRestore)) {
      try {
        if (FileSystem.exists(info.originalPath) && !overwrite) {
          failed.push({ path: info.originalPath, error: 'file already exists' });
          continue;
        }
        const parentDir = dirname(info.originalPath);
        if (parentDir && !FileSystem.exists(parentDir)) FileSystem.makedirs(parentDir);

        if (dryRun) {
          restored.push(info.originalPath);
        } else {
          FileSystem.move(info.trashFile, info.originalPath);
          FileSystem.remove(info.infoFile);
          restored.push(info.originalPath);
        }
      } catch (error) {
        failed.push({ path: info.originalPath, error: error instanceof Error ? error.message : String(error) });
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

export function listTrashed(trashDir: string, operator: string | null = null): ListResult {
  validateOperator(operator);
  const restorer = new SafeRestore({ trashDir, operator });
  const infoList = restorer.listTrashed();
  return { success: true, total: infoList.length, files: infoList };
}

export function restore(
  trashDir: string,
  target: RestoreTarget,
  operator: string | null = null,
  overwrite: boolean = false,
  dryRun: boolean = false,
  parseIndexRanges: boolean = true
): RestoreResult {
  validateOperator(operator);
  const restorer = new SafeRestore({ trashDir, operator });

  let actualTarget: RestoreTarget = target;
  if (parseIndexRanges && typeof target === 'string') {
    if (/^[\d,\s\-]+$/.test(target.trim())) {
      try {
        actualTarget = parseIndexSpec(target);
      } catch {
        actualTarget = target;
      }
    }
  }

  return restorer.restore(actualTarget, overwrite, dryRun);
}
