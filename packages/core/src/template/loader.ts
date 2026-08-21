/**
 * 模板加载器
 * 从文件系统读取和缓存模板文件
 */

import { readFile } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import type {
  TemplateLoaderOptions,
  CacheStats,
  TemplateError,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(__filename), '..');

/**
 * 模板加载器
 */
export class TemplateLoader {
  private cache: Map<string, string>;
  private searchDirs: string[];
  private enabled: boolean;
  private stats = { hits: 0, misses: 0 };

  constructor(options: TemplateLoaderOptions = {}) {
    this.cache = new Map();
    this.searchDirs = options.searchDirs ?? [];
    this.enabled = options.cacheEnabled !== false;
  }

  /**
   * 加载模板（异步）
   */
  async load(templatePath: string): Promise<string> {
    const absolutePath = this.resolvePath(templatePath);

    // 检查缓存
    if (this.enabled && this.cache.has(absolutePath)) {
      this.stats.hits++;
      return this.cache.get(absolutePath)!;
    }

    this.stats.misses++;

    // 验证文件格式
    if (!absolutePath.endsWith('.txt') && !absolutePath.endsWith('.md')) {
      const error: TemplateError = new Error(
        `Unsupported file format: ${absolutePath}. Only .txt and .md are supported.`
      ) as TemplateError;
      (error as any).code = 'UNSUPPORTED_FORMAT';
      (error as any).path = absolutePath;
      throw error;
    }

    // 读取文件
    try {
      const content = await readFile(absolutePath, 'utf-8');

      // 缓存
      if (this.enabled) {
        this.cache.set(absolutePath, content);
      }

      return content;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        const error: TemplateError = new Error(
          `Template file not found: ${absolutePath}\n` +
          `Working directory: ${process.cwd()}\n` +
          `Please ensure the file exists.`
        ) as TemplateError;
        (error as any).code = 'FILE_NOT_FOUND';
        (error as any).path = absolutePath;
        throw error;
      }
      const error: TemplateError = new Error(
        `Failed to read template file: ${absolutePath}`
      ) as TemplateError;
      (error as any).code = 'READ_ERROR';
      (error as any).path = absolutePath;
      (error as any).cause = err;
      throw error;
    }
  }

  /**
   * 加载模板（同步）
   */
  loadSync(templatePath: string): string {
    throw new Error('Synchronous load not implemented. Use async load() instead.');
  }

  /**
   * 解析路径为绝对路径
   * @param templatePath 模板路径
   * @returns 解析后的绝对路径
   * @throws TemplateError 如果文件格式不支持
   */
  resolvePath(templatePath: string): string {
    // 如果是绝对路径，直接使用
    if (this.isAbsolute(templatePath)) {
      return templatePath;
    }

    // 相对路径：以 cwd 为基准目录
    const cwd = process.cwd();

    // 1. 优先尝试 cwd/.agentdev/prompts
    const agentDir = resolve(cwd, '.agentdev', 'prompts');
    const agentCandidate = resolve(agentDir, templatePath);
    if (this.fileExists(agentCandidate)) {
      return agentCandidate;
    }
    if (this.fileExists(agentCandidate + '.md')) {
      return agentCandidate + '.md';
    }
    if (this.fileExists(agentCandidate + '.txt')) {
      return agentCandidate + '.txt';
      }

    // 2. 其次直接用 cwd 作为基准目录
    const fallbackCandidate = resolve(cwd, templatePath);
    if (this.fileExists(fallbackCandidate)) {
      return fallbackCandidate;
    }
    if (this.fileExists(fallbackCandidate + '.md')) {
      return fallbackCandidate + '.md';
    }
    if (this.fileExists(fallbackCandidate + '.txt')) {
      return fallbackCandidate + '.txt';
      }

    // 3. 如果还找不到，抛出错误
    throw new Error(
      `Template file not found: ${templatePath}\n` +
      `Searched in:\n` +
      `  - ${this.searchDirs.map(d => resolve(cwd, d)).join('\n  - ')}\n` +
      `  - ${agentDir}\n` +
      `  - ${resolve(cwd, templatePath)} (cwd base)\n` +
      `Working directory: ${cwd}`
    );
  }

  /**
   * 清除缓存
   */
  clearCache(pattern?: string): void {
    if (!pattern) {
      this.cache.clear();
      this.stats = { hits: 0, misses: 0 };
      return;
    }

    // 按模式清除（简单通配符匹配）
    const regex = new RegExp(
      '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
    );

    for (const key of this.cache.keys()) {
      if (regex.test(key)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * 批量加载
   */
  async loadMultiple(paths: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const path of paths) {
      try {
        result.set(path, await this.load(path));
      } catch {
        // 跳过加载失败的文件
      }
    }
    return result;
  }

  /**
   * 获取缓存统计
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      size: this.cache.size,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: total > 0 ? this.stats.hits / total : 0,
    };
  }

  /**
   * 检查是否是绝对路径
   */
  private isAbsolute(path: string): boolean {
    return path.startsWith('/') || !!path.match(/^[A-Za-z]:\\/);
  }

  /**
   * 简单检查文件是否存在（同步，不进行实际IO）
   */
  private fileExists(path: string): boolean {
    return existsSync(path);
  }
}
