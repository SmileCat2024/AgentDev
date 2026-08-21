/**
 * 自定义请求头动态解析工具
 *
 * 支持 valueMode:
 * - 'static': 使用 value 原样
 * - 'uuid':   每次调用生成新的 UUID v4
 * - 'random': 每次调用生成新的随机整数字符串
 */

import { randomUUID } from 'crypto';
import type { CustomHeaderEntry } from '../core/config.js';

/**
 * 将 CustomHeaderEntry[] 解析为扁平的 Record<string,string>。
 * 对于 uuid / random 模式，每次调用都会生成新值。
 */
export function resolveCustomHeaders(
  headers?: CustomHeaderEntry[] | null,
): Record<string, string> {
  if (!headers || headers.length === 0) return {};
  const result: Record<string, string> = {};
  for (const h of headers) {
    const key = (h.key ?? '').trim();
    if (!key) continue;
    const mode = h.valueMode ?? 'static';
    if (mode === 'uuid') {
      result[key] = randomUUID();
    } else if (mode === 'random') {
      result[key] = String(Math.floor(Math.random() * 1e16));
    } else {
      result[key] = h.value ?? '';
    }
  }
  return result;
}
