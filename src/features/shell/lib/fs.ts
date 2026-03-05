/**
 * 文件系统工具类
 *
 * 复刻自 safe_rm.py 的 FileSystem 类，专注于 Windows 平台
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
  constants,
} from 'fs';
import {
  join,
  dirname,
  basename,
  isAbsolute,
  normalize,
  relative,
} from 'path';
import {
  SafeRmError,
  throwPathTooLongError,
  throwIllegalCharError,
  throwPermissionDeniedError,
  throwFileNotFoundError,
} from './errors.js';
import { ErrorCode } from './types.js';

/**
 * Windows 最大路径长度
 */
const MAX_PATH = 260;

/**
 * 非法路径字符（Windows）
 */
const ILLEGAL_CHARS = '<>:"|?*';

/**
 * 系统目录列表
 */
const SYSTEM_DIRS = [
  process.env.SystemRoot || 'C:\\Windows',
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
];

/**
 * 文件系统工具类
 */
export class FileSystem {
  /**
   * 验证路径合法性
   */
  static validatePath(path: string): void {
    if (!path || typeof path !== 'string') {
      throw new SafeRmError(
        ErrorCode.ERROR_INVALID_PATH,
        '路径无效',
        { path: String(path) }
      );
    }

    // 检查路径长度
    if (path.length > MAX_PATH) {
      throwPathTooLongError(path, path.length, MAX_PATH);
    }

    // 检查非法字符
    for (const char of ILLEGAL_CHARS) {
      if (path.includes(char)) {
        // 盘号后允许冒号
        const colonContext = path.length >= 2 && path[1] === ':' && char === ':';
        if (!colonContext) {
          throwIllegalCharError(path, char);
        }
      }
    }
  }

  /**
   * 检查路径是否存在
   */
  static exists(path: string): boolean {
    return existsSync(path);
  }

  /**
   * 检查符号链接是否存在
   */
  static lexists(path: string): boolean {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 检查是否为目录
   */
  static isdir(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * 检查是否为文件
   */
  static isfile(path: string): boolean {
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  }

  /**
   * 检查是否为符号链接
   */
  static islink(path: string): boolean {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  }

  /**
   * 获取文件大小
   */
  static getsize(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  /**
   * 创建目录（带错误处理）
   */
  static makedirs(path: string, mode: number = 0o755): void {
    if (existsSync(path) && FileSystem.isdir(path)) {
      return;
    }

    try {
      mkdirSync(path, { mode, recursive: true });
    } catch (error: any) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throwPermissionDeniedError(path, '创建目录');
      }
      throw new SafeRmError(
        ErrorCode.ERROR_CREATE_PARENT_FAILED,
        `无法创建目录: ${error.message}`,
        { path, os_error: error.code }
      );
    }
  }

  /**
   * 移动文件或目录（带错误处理）
   * 复刻自 Python shutil.move，支持跨卷移动
   */
  static move(src: string, dst: string): void {
    try {
      // 确保目标目录存在
      const dstDir = dirname(dst);
      if (!existsSync(dstDir)) {
        this.makedirs(dstDir);
      }

      // 先尝试 rename（适用于同卷移动）
      renameSync(src, dst);
    } catch (error: any) {
      // 处理跨卷移动：使用复制+删除的方式
      if (error.code === 'EXDEV' || error.code === 'ENOENT') {
        try {
          this._copyAndDelete(src, dst);
        } catch (copyError: any) {
          if (copyError.code === 'EACCES' || copyError.code === 'EPERM') {
            throw new SafeRmError(
              ErrorCode.ERROR_FILE_LOCKED,
              '文件被占用或无权限访问',
              { source: src, destination: dst }
            );
          }
          throw new SafeRmError(
            ErrorCode.ERROR_UNKNOWN,
            `跨卷移动文件失败: ${copyError.message}`,
            { source: src, destination: dst }
          );
        }
        return;
      }
      
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throw new SafeRmError(
          ErrorCode.ERROR_FILE_LOCKED,
          '文件被占用或无权限访问',
          { source: src, destination: dst }
        );
      }
      
      throw new SafeRmError(
        ErrorCode.ERROR_UNKNOWN,
        `移动文件失败: ${error.message}`,
        { source: src, destination: dst }
      );
    }
  }

  /**
   * 复制并删除（用于跨卷移动）
   */
  private static _copyAndDelete(src: string, dst: string): void {
    const srcStat = statSync(src);
    
    if (srcStat.isDirectory()) {
      // 递归复制目录
      if (!existsSync(dst)) {
        mkdirSync(dst, { recursive: true });
      }
      
      const entries = readdirSync(src, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = join(src, entry.name);
        const dstPath = join(dst, entry.name);
        this._copyAndDelete(srcPath, dstPath);
      }
      
      // 删除源目录
      rmSync(src, { recursive: true, force: true });
    } else {
      // 复制文件
      copyFileSync(src, dst);
      // 删除源文件
      rmSync(src, { force: true });
    }
  }

  /**
   * 删除文件或目录（带错误处理）
   */
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
      throw new SafeRmError(
        ErrorCode.ERROR_UNKNOWN,
        `删除失败: ${error.message}`,
        { path }
      );
    }
  }

  /**
   * 描述文件类型
   */
  static describe(path: string): string {
    if (this.islink(path)) {
      return 'symbolic link';
    }
    if (this.isdir(path)) {
      const base = basename(path);
      if (base === '.') return "'.' directory";
      if (base === '..') return "'..' directory";
      return 'directory';
    }
    if (this.isfile(path)) {
      if (this.getsize(path) === 0) {
        return 'regular empty file';
      }
      return 'regular file';
    }
    if (!this.exists(path)) {
      return 'non existent';
    }
    return 'entry';
  }

  /**
   * 获取文件或目录大小
   */
  static getFileSize(path: string): number {
    if (!existsSync(path)) {
      return 0;
    }

    if (FileSystem.isfile(path)) {
      return FileSystem.getsize(path);
    }

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
          } catch {
            // 忽略无权限的文件
          }
        }
      } catch {
        // 忽略目录读取错误
      }
      return total;
    }

    return 0;
  }

  /**
   * 检查磁盘空间是否足够（简化版本）
   * 真实实现需要使用 Windows API，这里采用捕获 ENOSPC 的方式
   */
  static checkDiskSpace(_path: string, _requiredSize: number): boolean {
    // 无法检查时假设足够
    // 实际操作中会捕获 ENOSPC 错误
    return true;
  }

  /**
   * 检查是否为系统文件
   */
  static isSystemFile(path: string): boolean {
    try {
      const absPath = normalize(path).toLowerCase();
      for (const sysDir of SYSTEM_DIRS) {
        if (sysDir && absPath.startsWith(normalize(sysDir).toLowerCase())) {
          return true;
        }
      }
    } catch {
      // 忽略错误
    }
    return false;
  }

  /**
   * 读取文件内容
   */
  static readFile(path: string): string {
    try {
      return readFileSync(path, 'utf-8');
    } catch (error: any) {
      throw new SafeRmError(
        ErrorCode.ERROR_UNKNOWN,
        `读取文件失败: ${error.message}`,
        { path }
      );
    }
  }

  /**
   * 写入文件内容
   */
  static writeFile(path: string, content: string): void {
    try {
      // 确保目录存在
      const dir = dirname(path);
      if (!existsSync(dir)) {
        this.makedirs(dir);
      }
      writeFileSync(path, content, 'utf-8');
    } catch (error: any) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throwPermissionDeniedError(path, '写入');
      }
      throw new SafeRmError(
        ErrorCode.ERROR_UNKNOWN,
        `写入文件失败: ${error.message}`,
        { path }
      );
    }
  }

  /**
   * 列出目录内容
   */
  static listDir(path: string): string[] {
    try {
      return readdirSync(path);
    } catch (error: any) {
      throw new SafeRmError(
        ErrorCode.ERROR_UNKNOWN,
        `列出目录失败: ${error.message}`,
        { path }
      );
    }
  }

  /**
   * 规范化路径为统一格式（使用 / 分隔符）
   */
  static normalizePath(path: string): string {
    return normalize(path).replace(/\\/g, '/');
  }

  /**
   * 检查是否应跳过特殊目录（. 或 ..）
   */
  static shouldSkipBySpecs(path: string): boolean {
    const base = basename(path);
    return base === '.' || base === '..';
  }
}
