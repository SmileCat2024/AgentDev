/**
 * 文件系统工具类
 */

import {
  existsSync,
  lstatSync,
  statSync,
  readdirSync,
  mkdirSync,
  renameSync,
  rmSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from 'fs';
import { join, dirname, basename, normalize } from 'path';
import {
  SafeRmError,
  throwPathTooLongError,
  throwIllegalCharError,
  throwPermissionDeniedError,
} from './errors.js';
import { ErrorCode } from './types.js';

const MAX_PATH = 260;
const ILLEGAL_CHARS = '<>:"|?*';

const SYSTEM_DIRS = [
  process.env.SystemRoot || 'C:\\Windows',
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
];

export class FileSystem {
  static validatePath(path: string): void {
    if (!path || typeof path !== 'string') {
      throw new SafeRmError(ErrorCode.ERROR_INVALID_PATH, '路径无效', { path: String(path) });
    }
    if (path.length > MAX_PATH) {
      throwPathTooLongError(path, path.length, MAX_PATH);
    }
    for (const char of ILLEGAL_CHARS) {
      if (path.includes(char)) {
        const colonContext = path.length >= 2 && path[1] === ':' && char === ':';
        if (!colonContext) {
          throwIllegalCharError(path, char);
        }
      }
    }
  }

  static exists(path: string): boolean {
    return existsSync(path);
  }

  static lexists(path: string): boolean {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  }

  static isdir(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  static isfile(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }

  static islink(path: string): boolean {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  }

  static getsize(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  static makedirs(path: string, mode: number = 0o755): void {
    if (existsSync(path) && FileSystem.isdir(path)) return;
    try {
      mkdirSync(path, { mode, recursive: true });
    } catch (error: any) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throwPermissionDeniedError(path, '创建目录');
      }
      throw new SafeRmError(ErrorCode.ERROR_CREATE_PARENT_FAILED, `无法创建目录: ${error.message}`, { path, os_error: error.code });
    }
  }

  static move(src: string, dst: string): void {
    try {
      const dstDir = dirname(dst);
      if (!existsSync(dstDir)) {
        this.makedirs(dstDir);
      }
      renameSync(src, dst);
    } catch (error: any) {
      if (error.code === 'EXDEV' || error.code === 'ENOENT') {
        try {
          this._copyAndDelete(src, dst);
        } catch (copyError: any) {
          if (copyError.code === 'EACCES' || copyError.code === 'EPERM') {
            throw new SafeRmError(ErrorCode.ERROR_FILE_LOCKED, '文件被占用或无权限访问', { source: src, destination: dst });
          }
          throw new SafeRmError(ErrorCode.ERROR_UNKNOWN, `跨卷移动文件失败: ${copyError.message}`, { source: src, destination: dst });
        }
        return;
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throw new SafeRmError(ErrorCode.ERROR_FILE_LOCKED, '文件被占用或无权限访问', { source: src, destination: dst });
      }
      throw new SafeRmError(ErrorCode.ERROR_UNKNOWN, `移动文件失败: ${error.message}`, { source: src, destination: dst });
    }
  }

  private static _copyAndDelete(src: string, dst: string): void {
    const srcStat = statSync(src);
    if (srcStat.isDirectory()) {
      if (!existsSync(dst)) {
        mkdirSync(dst, { recursive: true });
      }
      const entries = readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = join(src, entry.name);
        const dstPath = join(dst, entry.name);
        this._copyAndDelete(srcPath, dstPath);
      }
      rmSync(src, { recursive: true, force: true });
    } else {
      copyFileSync(src, dst);
      rmSync(src, { force: true });
    }
  }

  static remove(path: string): void {
    try {
      if (FileSystem.isdir(path)) {
        rmSync(path, { recursive: true, force: true });
      } else {
        rmSync(path, { force: true });
      }
    } catch (error: any) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throwPermissionDeniedError(path, '删除');
      }
      throw new SafeRmError(ErrorCode.ERROR_UNKNOWN, `删除失败: ${error.message}`, { path });
    }
  }

  static isSystemFile(path: string): boolean {
    try {
      const absPath = normalize(path).toLowerCase();
      for (const sysDir of SYSTEM_DIRS) {
        if (sysDir && absPath.startsWith(normalize(sysDir).toLowerCase())) {
          return true;
        }
      }
    } catch {}
    return false;
  }

  static readFile(path: string): string {
    try {
      return readFileSync(path, 'utf-8');
    } catch (error: any) {
      throw new SafeRmError(ErrorCode.ERROR_UNKNOWN, `读取文件失败: ${error.message}`, { path });
    }
  }

  static writeFile(path: string, content: string): void {
    try {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        this.makedirs(dir);
      }
      writeFileSync(path, content, 'utf-8');
    } catch (error: any) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throwPermissionDeniedError(path, '写入');
      }
      throw new SafeRmError(ErrorCode.ERROR_UNKNOWN, `写入文件失败: ${error.message}`, { path });
    }
  }

  static listDir(path: string): string[] {
    try {
      return readdirSync(path);
    } catch (error: any) {
      throw new SafeRmError(ErrorCode.ERROR_UNKNOWN, `列出目录失败: ${error.message}`, { path });
    }
  }

  static normalizePath(path: string): string {
    return normalize(path).replace(/\\/g, '/');
  }

  static shouldSkipBySpecs(path: string): boolean {
    const base = basename(path);
    return base === '.' || base === '..';
  }

  static getFileSize(path: string): number {
    if (!existsSync(path)) return 0;
    if (FileSystem.isfile(path)) return FileSystem.getsize(path);
    if (FileSystem.isdir(path)) {
      let total = 0;
      try {
        const entries = readdirSync(path, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(path, entry.name);
          try {
            if (entry.isDirectory()) {
              total += this.getFileSize(fullPath);
            } else if (entry.isFile()) {
              total += FileSystem.getsize(fullPath);
            }
          } catch {}
        }
      } catch {}
      return total;
    }
    return 0;
  }
}
