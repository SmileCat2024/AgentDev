/**
 * OpenClaw 插件清单解析器
 *
 * 负责查找和解析 openclaw.plugin.json
 */

import { readFile, readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';
import type { OpenClawPluginManifest } from './types.js';

/**
 * 查找插件根目录
 *
 * @param roots 插件根目录列表
 * @returns 插件根目录路径列表
 */
export async function discoverPluginRoots(roots: string[]): Promise<string[]> {
  const pluginRoots: string[] = [];

  for (const root of roots) {
    try {
      const stats = await stat(root);
      if (!stats.isDirectory()) {
        continue;
      }

      // 检查是否是插件根目录（包含 openclaw.plugin.json）
      const manifestPath = join(root, 'openclaw.plugin.json');
      try {
        await stat(manifestPath);
        pluginRoots.push(root);
      } catch {
        // 如果不是插件根目录，检查子目录
        const entries = await readdir(root, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subPath = join(root, entry.name);
            const subManifestPath = join(subPath, 'openclaw.plugin.json');
            try {
              await stat(subManifestPath);
              pluginRoots.push(subPath);
            } catch {
              // 不是插件目录，跳过
            }
          }
        }
      }
    } catch {
      // 路径不存在或无权限，跳过
    }
  }

  return pluginRoots;
}

/**
 * 解析插件清单
 *
 * @param pluginRoot 插件根目录
 * @returns 插件清单
 */
export async function parsePluginManifest(pluginRoot: string): Promise<OpenClawPluginManifest> {
  const manifestPath = join(pluginRoot, 'openclaw.plugin.json');

  try {
    const content = await readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(content) as OpenClawPluginManifest;

    // 验证必需字段
    if (!manifest.id || typeof manifest.id !== 'string') {
      throw new Error(`Plugin manifest missing required field: id`);
    }
    if (!manifest.name || typeof manifest.name !== 'string') {
      throw new Error(`Plugin manifest missing required field: name`);
    }
    if (!manifest.version || typeof manifest.version !== 'string') {
      throw new Error(`Plugin manifest missing required field: version`);
    }
    if (!manifest.main || typeof manifest.main !== 'string') {
      throw new Error(`Plugin manifest missing required field: main`);
    }

    return manifest;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse plugin manifest at ${manifestPath}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * 验证插件清单
 *
 * @param manifest 插件清单
 * @returns 验证结果
 */
export function validatePluginManifest(manifest: OpenClawPluginManifest): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // 检查 ID 格式（只允许字母、数字、下划线、连字符）
  if (!/^[a-zA-Z0-9_-]+$/.test(manifest.id)) {
    errors.push(`Plugin id must match /^[a-zA-Z0-9_-]+$/, got: ${manifest.id}`);
  }

  // 检查版本格式（语义化版本：major.minor.patch[-prerelease][+build]）
  // 参考：https://semver.org/#is-there-a-suggested-regular-expression
  const semverRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
  if (!semverRegex.test(manifest.version)) {
    errors.push(`Plugin version should follow semver (e.g., 1.0.0, 2.1.3-beta), got: ${manifest.version}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
