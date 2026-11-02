/**
 * serveResourceFetch 单元测试（ADR-0038 资源读取协议 runtime 侧）。
 *
 * 契约声明：
 * 1. 合法 {rootId, rel} 返回根内文件内容的 base64；
 * 2. resolve 后逃出资源根的 rel 一律 forbidden——这是协议的安全边界，
 *    浏览器侧 URL 不得成为任意文件读取面；
 * 3. 未知 rootId / 根表缺失 → unknown_root；文件不存在 → not_found；
 * 4. 形状不符的 payload → invalid（不抛异常，错误以 code 返回）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveResourceFetch } from '../src/core/agent/resource-serve.js';

describe('serveResourceFetch', () => {
  const tmpRoot = join(tmpdir(), `agentdev-res-serve-${process.pid}-${Date.now()}`);
  const pkgA = join(tmpRoot, 'pkg-a');
  const pkgB = join(tmpRoot, 'pkg-b');
  const outside = join(tmpRoot, 'outside');
  const roots = [pkgA, pkgB];

  beforeAll(() => {
    mkdirSync(join(pkgA, 'dist', 'templates'), { recursive: true });
    mkdirSync(join(pkgB, 'dist', 'templates'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(pkgA, 'dist', 'templates', 'read.render.js'), '// pkg-a read template');
    writeFileSync(join(pkgA, 'dist', 'chunk.js'), '// pkg-a chunk');
    writeFileSync(join(pkgB, 'dist', 'templates', 'read.render.js'), '// pkg-b read template');
    writeFileSync(join(outside, 'secret.js'), '// outside the roots');
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns base64 content for a valid entry inside the root', async () => {
    const result = await serveResourceFetch(roots, { rootId: 0, rel: 'dist/templates/read.render.js' });
    expect(result.ok).toBe(true);
    expect(Buffer.from(result.data!, 'base64').toString('utf-8')).toBe('// pkg-a read template');
  });

  it('serves the same rel from different roots without cross-talk', async () => {
    const a = await serveResourceFetch(roots, { rootId: 0, rel: 'dist/templates/read.render.js' });
    const b = await serveResourceFetch(roots, { rootId: 1, rel: 'dist/templates/read.render.js' });
    expect(Buffer.from(a.data!, 'base64').toString('utf-8')).toBe('// pkg-a read template');
    expect(Buffer.from(b.data!, 'base64').toString('utf-8')).toBe('// pkg-b read template');
  });

  it('rejects traversal escaping the root with forbidden', async () => {
    const upUp = await serveResourceFetch(roots, { rootId: 0, rel: 'dist/../../outside/secret.js' });
    expect(upUp).toEqual({ ok: false, code: 'forbidden' });
  });

  it('rejects rel resolving to the root itself (no file to read) without leaking', async () => {
    const result = await serveResourceFetch(roots, { rootId: 0, rel: '.' });
    // 根目录 resolve 后仍在边界内（等于根），readFile 目录失败 → not_found
    expect(result.ok).toBe(false);
  });

  it('returns unknown_root for out-of-range rootId or missing roots table', async () => {
    expect(await serveResourceFetch(roots, { rootId: 2, rel: 'dist/x.js' })).toEqual({ ok: false, code: 'unknown_root' });
    expect(await serveResourceFetch(undefined, { rootId: 0, rel: 'dist/x.js' })).toEqual({ ok: false, code: 'unknown_root' });
  });

  it('returns not_found for a missing file inside the root', async () => {
    expect(await serveResourceFetch(roots, { rootId: 0, rel: 'dist/templates/ghost.render.js' })).toEqual({ ok: false, code: 'not_found' });
  });

  it('returns invalid for malformed payloads instead of throwing', async () => {
    expect(await serveResourceFetch(roots, null)).toEqual({ ok: false, code: 'invalid' });
    expect(await serveResourceFetch(roots, {})).toEqual({ ok: false, code: 'invalid' });
    expect(await serveResourceFetch(roots, { rootId: '0', rel: 'dist/x.js' })).toEqual({ ok: false, code: 'invalid' });
    expect(await serveResourceFetch(roots, { rootId: 0.5, rel: 'dist/x.js' })).toEqual({ ok: false, code: 'invalid' });
    expect(await serveResourceFetch(roots, { rootId: 0, rel: '' })).toEqual({ ok: false, code: 'invalid' });
  });
});
