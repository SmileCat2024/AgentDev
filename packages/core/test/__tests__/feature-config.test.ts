import { describe, it, expect } from 'vitest';

import { resolveFeatureConfig } from '../../src/core/feature-config.js';
import type { FeatureConfig } from '../../src/core/feature-config.js';

describe('resolveFeatureConfig', () => {
  // ========== 规范 6：空队列 ==========

  describe('空队列', () => {
    it('should return empty merged / provenance / warnings for empty queue', () => {
      expect(resolveFeatureConfig([])).toEqual({
        merged: {},
        provenance: {},
        warnings: [],
      });
    });
  });

  // ========== 单层透传 ==========

  describe('单层透传', () => {
    it('should pass through a single layer unchanged', () => {
      const layer: FeatureConfig = {
        lsp: { mode: 'socket', port: 9100 },
        shell: { timeoutMs: 30000 },
      };

      const { merged, provenance, warnings } = resolveFeatureConfig([layer]);

      expect(merged).toEqual(layer);
      expect(warnings).toEqual([]);
      expect(provenance).toEqual({
        'lsp.mode': { value: 'socket', sourceIndex: 0 },
        'lsp.port': { value: 9100, sourceIndex: 0 },
        'shell.timeoutMs': { value: 30000, sourceIndex: 0 },
      });
    });
  });

  // ========== 规范 2：标量替换（后层胜） ==========

  describe('多层标量覆盖', () => {
    it('should let later layers win for scalars', () => {
      const queue: FeatureConfig[] = [
        { lsp: { mode: 'stdio', port: 9100 } },
        { lsp: { mode: 'socket' } },
      ];

      const { merged, provenance } = resolveFeatureConfig(queue);

      expect(merged.lsp).toEqual({ mode: 'socket', port: 9100 });
      expect(provenance['lsp.mode']).toEqual({ value: 'socket', sourceIndex: 1 });
      // 未被后层触碰的字段继承，provenance 指向最初写入层
      expect(provenance['lsp.port']).toEqual({ value: 9100, sourceIndex: 0 });
    });
  });

  // ========== 规范 1：对象递归合并 ==========

  describe('嵌套对象递归合并', () => {
    it('should deep merge nested objects across layers', () => {
      const queue: FeatureConfig[] = [
        { lsp: { typescript: { enabled: true, level: 'warn' } } },
        { lsp: { typescript: { level: 'error' }, python: { enabled: false } } },
      ];

      const { merged } = resolveFeatureConfig(queue);

      expect(merged.lsp).toEqual({
        typescript: { enabled: true, level: 'error' },
        python: { enabled: false },
      });
    });

    it('should treat object replacing scalar and vice versa as replacement', () => {
      const queue: FeatureConfig[] = [
        { shell: { timeout: 1000 } },
        { shell: { timeout: { warnMs: 500, killMs: 1000 } } },
        { shell: { timeout: 2000 } },
      ];

      const { merged } = resolveFeatureConfig(queue);

      expect(merged.shell).toEqual({ timeout: 2000 });
    });
  });

  // ========== 规范 3：数组整体替换 ==========

  describe('数组替换', () => {
    it('should replace arrays wholesale (same length)', () => {
      const queue: FeatureConfig[] = [
        { websearch: { engines: ['bing', 'google'] } },
        { websearch: { engines: ['duckduckgo', 'brave'] } },
      ];

      const { merged, provenance } = resolveFeatureConfig(queue);

      expect(merged.websearch).toEqual({ engines: ['duckduckgo', 'brave'] });
      expect(provenance['websearch.engines'].sourceIndex).toBe(1);
    });

    it('should replace arrays with different lengths', () => {
      const queue: FeatureConfig[] = [
        { websearch: { engines: ['a', 'b', 'c'], limit: 5 } },
        { websearch: { engines: ['x'] } },
      ];

      const { merged } = resolveFeatureConfig(queue);

      expect(merged.websearch).toEqual({ engines: ['x'], limit: 5 });
    });

    it('should replace array of objects without per-key merging', () => {
      const queue: FeatureConfig[] = [
        { mcp: { servers: [{ name: 'a', cmd: 'x' }] } },
        { mcp: { servers: [{ name: 'b' }] } },
      ];

      const { merged } = resolveFeatureConfig(queue);

      expect(merged.mcp).toEqual({ servers: [{ name: 'b' }] });
    });
  });

  // ========== 规范 4：null 删除 + warning ==========

  describe('null 删除', () => {
    it('should remove the field and emit a null-removed warning', () => {
      const queue: FeatureConfig[] = [
        { lsp: { mode: 'socket', port: 9100 } },
        { lsp: { port: null } },
      ];

      const { merged, provenance, warnings } = resolveFeatureConfig(queue);

      expect(merged.lsp).toEqual({ mode: 'socket' });
      expect(provenance['lsp.port']).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        fieldPath: 'lsp.port',
        layerIndex: 1,
        kind: 'null-removed',
      });
      expect(typeof warnings[0].message).toBe('string');
    });

    it('should delete nested subtree provenance when an object branch is nulled', () => {
      const queue: FeatureConfig[] = [
        { lsp: { typescript: { enabled: true, level: 'warn' } } },
        { lsp: { typescript: null } },
      ];

      const { merged, provenance, warnings } = resolveFeatureConfig(queue);

      expect(merged.lsp).toEqual({});
      expect(provenance['lsp.typescript']).toBeUndefined();
      expect(provenance['lsp.typescript.enabled']).toBeUndefined();
      expect(provenance['lsp.typescript.level']).toBeUndefined();
      expect(warnings[0].fieldPath).toBe('lsp.typescript');
      expect(warnings[0].layerIndex).toBe(1);
    });

    it('should remove a field that only exists in the same layer write order', () => {
      // 同一层先写后删：最终不存在
      const queue: FeatureConfig[] = [{ shell: { extra: 'x' } }, { shell: { extra: 'y' } }, { shell: { extra: null } }];

      const { merged, warnings } = resolveFeatureConfig(queue);

      expect(merged.shell).toEqual({});
      expect(warnings[0]).toMatchObject({ fieldPath: 'shell.extra', layerIndex: 2 });
    });

    it('should not warn when a later layer re-sets a previously removed field', () => {
      const queue: FeatureConfig[] = [
        { lsp: { port: 1 } },
        { lsp: { port: null } },
        { lsp: { port: 2 } },
      ];

      const { merged, provenance, warnings } = resolveFeatureConfig(queue);

      expect(merged.lsp).toEqual({ port: 2 });
      expect(provenance['lsp.port']).toEqual({ value: 2, sourceIndex: 2 });
      expect(warnings).toHaveLength(1); // 只有中间层的删除产生 warning
    });
  });

  // ========== D8：值相同也是 pin ==========

  describe('值相同的 pin', () => {
    it('should point provenance at the later layer even when values are equal', () => {
      const queue: FeatureConfig[] = [
        { shell: { timeoutMs: 30000 } },
        { shell: { timeoutMs: 30000 } },
      ];

      const { merged, provenance } = resolveFeatureConfig(queue);

      expect(merged.shell).toEqual({ timeoutMs: 30000 });
      expect(provenance['shell.timeoutMs']).toEqual({ value: 30000, sourceIndex: 1 });
    });
  });

  // ========== 规范 5 / D6：provenance 路径正确性 ==========

  describe('多级嵌套 provenance 路径', () => {
    it('should use full dotted paths including featureName prefix', () => {
      const queue: FeatureConfig[] = [
        {
          memory: {
            store: { backend: 'sqlite', pool: { min: 1, max: 10 } },
          },
        },
        {
          memory: {
            store: { pool: { max: 20 } },
          },
        },
      ];

      const { provenance } = resolveFeatureConfig(queue);

      expect(Object.keys(provenance).sort()).toEqual([
        'memory.store.backend',
        'memory.store.pool.max',
        'memory.store.pool.min',
      ]);
      expect(provenance['memory.store.backend']).toEqual({ value: 'sqlite', sourceIndex: 0 });
      expect(provenance['memory.store.pool.min']).toEqual({ value: 1, sourceIndex: 0 });
      expect(provenance['memory.store.pool.max']).toEqual({ value: 20, sourceIndex: 1 });
    });

    it('should keep provenance in sync with merged after object-over-object replacement', () => {
      // 标量被对象替换后再深入：provenance 反映最终写入层
      const queue: FeatureConfig[] = [
        { lsp: { config: 'legacy' } },
        { lsp: { config: { nested: { leaf: true } } } },
      ];

      const { merged, provenance } = resolveFeatureConfig(queue);

      expect(merged.lsp).toEqual({ config: { nested: { leaf: true } } });
      expect(provenance['lsp.config']).toBeUndefined();
      expect(provenance['lsp.config.nested.leaf']).toEqual({ value: true, sourceIndex: 1 });
    });
  });

  // ========== 纯函数纪律 ==========

  describe('纯函数纪律', () => {
    it('should not mutate input queue layers', () => {
      const layer0: FeatureConfig = { lsp: { typescript: { level: 'warn' }, tags: ['a'] } };
      const layer1: FeatureConfig = { lsp: { typescript: { level: 'error' }, tags: ['b'] } };
      const snapshot = JSON.parse(JSON.stringify([layer0, layer1]));

      resolveFeatureConfig([layer0, layer1]);

      expect(JSON.parse(JSON.stringify([layer0, layer1]))).toEqual(snapshot);
    });

    it('should return a result decoupled from input references', () => {
      const layer: FeatureConfig = { shell: { allow: ['a', 'b'] } };
      const { merged } = resolveFeatureConfig([layer]);

      (layer.shell as Record<string, unknown>).allow.push('c');

      expect((merged.shell as Record<string, unknown>).allow).toEqual(['a', 'b']);
    });
  });
});
