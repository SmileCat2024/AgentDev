/**
 * 资源读取协议的 runtime 侧服务（ADR-0038）。
 *
 * resource.fetch 类型化宿主定向请求的处理核心：按 rootId 定位资源根，
 * 在根内解析并读取文件，返回 base64 内容。安全边界是包根前缀约束——
 * resolve 后的绝对路径不得逃出根，越界一律 forbidden。
 */
import { readFile } from 'fs/promises';
import { resolve, sep } from 'path';

export interface ResourceFetchResult {
  ok: boolean;
  data?: string;
  code?: 'invalid' | 'unknown_root' | 'forbidden' | 'not_found';
}

/**
 * @param roots 资源根表（realpath 后的 feature 包根；索引即 rootId）
 * @param payload 请求载荷，契约形状 `{ rootId: number, rel: string }`
 */
export async function serveResourceFetch(roots: string[] | undefined, payload: unknown): Promise<ResourceFetchResult> {
  const record = (payload !== null && typeof payload === 'object') ? payload as Record<string, unknown> : null;
  const rootId = record?.rootId;
  const rel = record?.rel;
  if (typeof rootId !== 'number' || !Number.isInteger(rootId) || typeof rel !== 'string' || !rel) {
    return { ok: false, code: 'invalid' };
  }
  const root = roots?.[rootId];
  if (!root) {
    return { ok: false, code: 'unknown_root' };
  }
  const target = resolve(root, rel);
  // 路径穿越防护：解析后的绝对路径不得逃出根（win32 盘符大小写不敏感，前缀比较统一小写）
  const targetLower = target.toLowerCase();
  const rootLower = root.toLowerCase();
  if (targetLower !== rootLower && !targetLower.startsWith(rootLower + sep)) {
    return { ok: false, code: 'forbidden' };
  }
  try {
    const content = await readFile(target);
    return { ok: true, data: content.toString('base64') };
  } catch {
    return { ok: false, code: 'not_found' };
  }
}
