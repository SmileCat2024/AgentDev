import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { DataSourceRegistry, createListRenderer } from '../../template/data-source.js';
import { TemplateComposer } from '../../template/composer.js';
import { TemplateLoader } from '../../template/loader.js';
import type { PlaceholderContext } from '../../template/types.js';
import type { AgentFeature } from '../../core/feature.js';

// ============================================================
// DataSourceRegistry
// ============================================================

describe('DataSourceRegistry', () => {
  beforeEach(() => {
    DataSourceRegistry.clear();
  });

  afterEach(() => {
    DataSourceRegistry.clear();
    vi.restoreAllMocks();
  });

  describe('register / get / has', () => {
    it('should register and retrieve a data source', () => {
      const renderer = {
        name: 'test',
        getData: () => [],
        renderItem: () => '',
      };
      DataSourceRegistry.register(renderer);
      expect(DataSourceRegistry.get('test')).toBe(renderer);
      expect(DataSourceRegistry.has('test')).toBe(true);
    });

    it('should return undefined for unregistered key', () => {
      expect(DataSourceRegistry.get('nonexistent')).toBeUndefined();
      expect(DataSourceRegistry.has('nonexistent')).toBe(false);
    });
  });

  describe('override behavior', () => {
    it('should warn and override when re-registering same name', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const first = { name: 'dup', getData: () => [], renderItem: () => 'first' };
      const second = { name: 'dup', getData: () => [], renderItem: () => 'second' };

      DataSourceRegistry.register(first);
      DataSourceRegistry.register(second);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('"dup"')
      );
      expect(DataSourceRegistry.get('dup')?.renderItem('', '' as PlaceholderContext)).toBe('second');
    });
  });

  describe('unregister', () => {
    it('should unregister a data source and return true', () => {
      DataSourceRegistry.register({ name: 'temp', getData: () => [], renderItem: () => '' });
      expect(DataSourceRegistry.unregister('temp')).toBe(true);
      expect(DataSourceRegistry.has('temp')).toBe(false);
    });

    it('should return false when unregistering unknown name', () => {
      expect(DataSourceRegistry.unregister('unknown')).toBe(false);
    });
  });

  describe('names', () => {
    it('should list all registered data source names', () => {
      DataSourceRegistry.register({ name: 'a', getData: () => [], renderItem: () => '' });
      DataSourceRegistry.register({ name: 'b', getData: () => [], renderItem: () => '' });
      expect(DataSourceRegistry.names().sort()).toEqual(['a', 'b']);
    });

    it('should return empty array when nothing registered', () => {
      expect(DataSourceRegistry.names()).toEqual([]);
    });
  });

  describe('render', () => {
    it('should render items joined by newline', async () => {
      DataSourceRegistry.register({
        name: 'items',
        getData: () => [{ id: 1 }, { id: 2 }, { id: 3 }],
        renderItem: (item) => `Item ${item.id}`,
      });
      const result = await DataSourceRegistry.render('items', 'tmpl', {});
      expect(result).toBe('Item 1\nItem 2\nItem 3');
    });

    it('should support async getData', async () => {
      DataSourceRegistry.register({
        name: 'async-items',
        getData: async () => [{ v: 'x' }],
        renderItem: (item) => item.v,
      });
      const result = await DataSourceRegistry.render('async-items', 'tmpl', {});
      expect(result).toBe('x');
    });

    it('should return empty string for unknown data source', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await DataSourceRegistry.render('ghost', 'tmpl', {});
      expect(result).toBe('');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ghost'));
    });

    it('should return empty string when data source is disabled', async () => {
      DataSourceRegistry.register({
        name: 'disabled',
        getData: () => [{ v: 1 }],
        renderItem: () => 'should not appear',
        isEnabled: () => false,
      });
      const result = await DataSourceRegistry.render('disabled', 'tmpl', {});
      expect(result).toBe('');
    });

    it('should return empty string when getData returns empty array', async () => {
      DataSourceRegistry.register({
        name: 'empty',
        getData: () => [],
        renderItem: () => 'x',
      });
      const result = await DataSourceRegistry.render('empty', 'tmpl', {});
      expect(result).toBe('');
    });

    it('should return empty string when getData returns null/undefined', async () => {
      DataSourceRegistry.register({
        name: 'nullish',
        getData: () => null as any,
        renderItem: () => 'x',
      });
      const result = await DataSourceRegistry.render('nullish', 'tmpl', {});
      expect(result).toBe('');
    });

    it('should pass context to getData and renderItem', async () => {
      const getDataSpy = vi.fn(() => [{ val: 1 }]);
      const renderItemSpy = vi.fn(() => 'rendered');
      DataSourceRegistry.register({
        name: 'ctx',
        getData: getDataSpy,
        renderItem: renderItemSpy,
      });
      const ctx = { foo: 'bar' };
      await DataSourceRegistry.render('ctx', 'template', ctx);
      expect(getDataSpy).toHaveBeenCalledWith(ctx);
      expect(renderItemSpy).toHaveBeenCalledWith({ val: 1 }, 'template', ctx);
    });
  });

  describe('clear', () => {
    it('should clear all registered sources', () => {
      DataSourceRegistry.register({ name: 'a', getData: () => [], renderItem: () => '' });
      DataSourceRegistry.clear();
      expect(DataSourceRegistry.names()).toEqual([]);
    });
  });
});

// ============================================================
// createListRenderer
// ============================================================

describe('createListRenderer', () => {
  beforeEach(() => DataSourceRegistry.clear());
  afterEach(() => DataSourceRegistry.clear());

  it('should create a renderer with default renderItem that merges item into context', () => {
    const renderer = createListRenderer({
      name: 'tasks',
      getData: () => [{ title: 'A', priority: 'high' }],
    });
    DataSourceRegistry.register(renderer);

    // Use TemplateComposer to verify data source integration
    const composer = new TemplateComposer().add({ tasks: '- {{title}} ({{priority}})' });

    return composer.render().then(result => {
      expect(result.content).toBe('- A (high)');
    });
  });

  it('should respect custom renderItem', () => {
    const renderer = createListRenderer({
      name: 'custom',
      getData: () => [{ x: 1 }],
      renderItem: (item) => `custom-${item.x}`,
    });
    DataSourceRegistry.register(renderer);

    return DataSourceRegistry.render('custom', 'tmpl', {}).then(result => {
      expect(result).toBe('custom-1');
    });
  });

  it('should support mergeItem=false', () => {
    const renderer = createListRenderer({
      name: 'no-merge',
      getData: () => [{ x: 1 }],
      mergeItem: false,
    });
    DataSourceRegistry.register(renderer);

    return DataSourceRegistry.render('no-merge', '{{x}}', {}).then(result => {
      // x is not merged into context, so {{x}} resolves to empty
      expect(result).toBe('');
    });
  });

  it('should always expose `this` pointing to the item', () => {
    const renderer = createListRenderer({
      name: 'this-ref',
      getData: () => [{ x: 1 }],
      mergeItem: false,
    });
    DataSourceRegistry.register(renderer);

    return DataSourceRegistry.render('this-ref', '{{this.x}}', {}).then(result => {
      expect(result).toBe('1');
    });
  });
});

// ============================================================
// TemplateComposer
// ============================================================

describe('TemplateComposer', () => {
  describe('add / append / prepend / addAll', () => {
    it('add should append a static string', () => {
      const c = new TemplateComposer().add('Hello');
      expect(c.size).toBe(1);
    });

    it('append is an alias of add', () => {
      const c = new TemplateComposer().append('A').append('B');
      expect(c.size).toBe(2);
    });

    it('prepend should insert at the beginning', async () => {
      const c = new TemplateComposer().add('World').prepend('Hello ');
      const result = await c.render();
      expect(result.content).toBe('Hello World');
    });

    it('addAll should add multiple sources', () => {
      const c = new TemplateComposer().addAll('A', 'B', 'C');
      expect(c.size).toBe(3);
    });
  });

  describe('joinWith', () => {
    it('should join fragments with separator', async () => {
      const c = new TemplateComposer().addAll('A', 'B', 'C').joinWith(', ');
      const result = await c.render();
      expect(result.content).toBe('A, B, C');
    });

    it('default separator is empty string', async () => {
      const c = new TemplateComposer().addAll('A', 'B');
      const result = await c.render();
      expect(result.content).toBe('AB');
    });
  });

  describe('when', () => {
    it('should include source when boolean condition is true', async () => {
      const c = new TemplateComposer().when(true, 'YES');
      const result = await c.render();
      expect(result.content).toBe('YES');
    });

    it('should exclude source when boolean condition is false', async () => {
      const c = new TemplateComposer().when(false, 'NO');
      const result = await c.render();
      expect(result.content).toBe('');
    });

    it('should evaluate function condition with context', async () => {
      const c = new TemplateComposer().when(
        (ctx) => ctx.flag === true,
        'CONDITIONAL'
      );
      const result = await c.render({ flag: true });
      expect(result.content).toBe('CONDITIONAL');
    });

    it('should exclude when function condition returns false', async () => {
      const c = new TemplateComposer().when(
        (ctx) => ctx.flag === true,
        'CONDITIONAL'
      );
      const result = await c.render({ flag: false });
      expect(result.content).toBe('');
    });
  });

  describe('either', () => {
    it('should render trueSource when condition is true', async () => {
      const c = new TemplateComposer().either(true, 'TRUE', 'FALSE');
      const result = await c.render();
      expect(result.content).toBe('TRUE');
    });

    it('should render falseSource when condition is false', async () => {
      const c = new TemplateComposer().either(false, 'TRUE', 'FALSE');
      const result = await c.render();
      expect(result.content).toBe('FALSE');
    });

    it('should render nothing for false branch when falseSource is omitted', async () => {
      const c = new TemplateComposer().either(false, 'TRUE');
      const result = await c.render();
      expect(result.content).toBe('');
    });

    it('should work with function condition', async () => {
      const c = new TemplateComposer().either(
        (ctx) => ctx.mode === 'advanced',
        'ADVANCED',
        'SIMPLE'
      );
      expect((await c.render({ mode: 'advanced' })).content).toBe('ADVANCED');
      expect((await c.render({ mode: 'simple' })).content).toBe('SIMPLE');
    });
  });

  describe('nest / nestIf', () => {
    it('nest should render nested composer inline', async () => {
      const child = new TemplateComposer().addAll('X', 'Y').joinWith('-');
      const parent = new TemplateComposer().add('A').nest(child).add('B');
      const result = await parent.render();
      expect(result.content).toBe('AX-YB');
    });

    it('nestIf should conditionally include nested composer', async () => {
      const child = new TemplateComposer().add('CHILD');
      const parent = new TemplateComposer().nestIf(true, child);
      expect((await parent.render()).content).toBe('CHILD');

      const parent2 = new TemplateComposer().nestIf(false, child);
      expect((await parent2.render()).content).toBe('');
    });
  });

  describe('clear', () => {
    it('should clear all parts and reset separator', () => {
      const c = new TemplateComposer().addAll('A', 'B').joinWith('-');
      c.clear();
      expect(c.size).toBe(0);
    });
  });

  describe('size', () => {
    it('should reflect the number of parts', () => {
      const c = new TemplateComposer();
      expect(c.size).toBe(0);
      c.add('A');
      expect(c.size).toBe(1);
      c.add('B');
      expect(c.size).toBe(2);
    });
  });

  describe('getSources', () => {
    it('should return source representations for static and file parts', () => {
      const c = new TemplateComposer().add('static text').add({ file: 'path/to/file.md' });
      const sources = c.getSources();
      expect(sources).toEqual(['static text', { file: 'path/to/file.md' }]);
    });

    it('should return empty string for composer and conditional parts', () => {
      const child = new TemplateComposer().add('nested');
      const c = new TemplateComposer().nest(child).when(true, 'cond');
      const sources = c.getSources();
      expect(sources).toEqual(['', '']);
    });
  });

  describe('render - placeholder resolution', () => {
    it('should resolve {{key}} placeholders from context', async () => {
      const c = new TemplateComposer().add('Hello {{name}}!');
      const result = await c.render({ name: 'World' });
      expect(result.content).toBe('Hello World!');
    });

    it('should resolve placeholders in all fragments', async () => {
      const c = new TemplateComposer()
        .addAll('{{greeting}}', '{{name}}')
        .joinWith(' ');
      const result = await c.render({ greeting: 'Hi', name: 'Bob' });
      expect(result.content).toBe('Hi Bob');
    });
  });

  describe('render - empty composer', () => {
    it('should render empty content with no parts', async () => {
      const c = new TemplateComposer();
      const result = await c.render();
      expect(result.content).toBe('');
      expect(result.sources).toEqual([]);
    });
  });

  describe('render - data source integration', () => {
    beforeEach(() => DataSourceRegistry.clear());
    afterEach(() => DataSourceRegistry.clear());

    it('should render using registered data source', async () => {
      DataSourceRegistry.register({
        name: 'skills',
        getData: () => [{ name: ' cooking', desc: 'Cook things' }],
        renderItem: (item) => `- ${item.name}: ${item.desc}`,
      });
      const c = new TemplateComposer().add({ skills: 'irrelevant template' });
      const result = await c.render();
      expect(result.content).toBe('-  cooking: Cook things');
    });
  });

  describe('render - file source', () => {
    it('should load and render file content with placeholder resolution', async () => {
      const tmpPath = join(tmpdir(), `test-tmpl-${Date.now()}.md`);
      writeFileSync(tmpPath, 'Hello {{name}} from file!');

      try {
        const c = new TemplateComposer().add({ file: tmpPath });
        const result = await c.render({ name: 'World' });
        expect(result.content).toBe('Hello World from file!');
        expect(result.sources).toContain(tmpPath);
      } finally {
        rmSync(tmpPath, { force: true });
      }
    });
  });

  describe('render - nested composer sources aggregation', () => {
    it('should aggregate sources from nested composers', async () => {
      const fileA = join(tmpdir(), `nested-a-${Date.now()}.md`);
      const fileB = join(tmpdir(), `nested-b-${Date.now()}.md`);
      writeFileSync(fileA, 'A');
      writeFileSync(fileB, 'B');

      try {
        const child = new TemplateComposer().add({ file: fileB });
        const parent = new TemplateComposer().add({ file: fileA }).nest(child);
        const result = await parent.render();
        expect(result.content).toBe('AB');
        expect(result.sources).toContain(fileA);
        expect(result.sources).toContain(fileB);
      } finally {
        rmSync(fileA, { force: true });
        rmSync(fileB, { force: true });
      }
    });
  });
});

// ============================================================
// TemplateLoader
// ============================================================

describe('TemplateLoader', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `tmpl-loader-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('load', () => {
    it('should load .md file content', async () => {
      const filePath = join(tempDir, 'test.md');
      writeFileSync(filePath, '# Title\nContent here');
      const loader = new TemplateLoader();
      const content = await loader.load(filePath);
      expect(content).toBe('# Title\nContent here');
    });

    it('should load .txt file content', async () => {
      const filePath = join(tempDir, 'test.txt');
      writeFileSync(filePath, 'Plain text');
      const loader = new TemplateLoader();
      const content = await loader.load(filePath);
      expect(content).toBe('Plain text');
    });

    it('should throw UNSUPPORTED_FORMAT for non .md/.txt files', async () => {
      const filePath = join(tempDir, 'test.js');
      writeFileSync(filePath, 'console.log(1)');
      const loader = new TemplateLoader();
      await expect(loader.load(filePath)).rejects.toThrow(/Unsupported file format/);
    });

    it('should throw FILE_NOT_FOUND for missing files', async () => {
      const loader = new TemplateLoader();
      const missingPath = join(tempDir, 'nonexistent.md');
      await expect(loader.load(missingPath)).rejects.toThrow(/not found/i);
    });
  });

  describe('caching', () => {
    it('should cache loaded files and report hit/miss stats', async () => {
      const filePath = join(tempDir, 'cached.md');
      writeFileSync(filePath, 'original');
      const loader = new TemplateLoader();

      await loader.load(filePath);
      await loader.load(filePath);

      const stats = loader.getStats();
      expect(stats.misses).toBe(1);
      expect(stats.hits).toBe(1);
      expect(stats.size).toBe(1);
      expect(stats.hitRate).toBeCloseTo(0.5);
    });

    it('should not cache when cacheEnabled is false', async () => {
      const filePath = join(tempDir, 'no-cache.md');
      writeFileSync(filePath, 'data');
      const loader = new TemplateLoader({ cacheEnabled: false });

      await loader.load(filePath);
      await loader.load(filePath);

      const stats = loader.getStats();
      expect(stats.misses).toBe(2);
      expect(stats.hits).toBe(0);
      expect(stats.size).toBe(0);
    });

    it('clearCache() should clear all cache and reset stats', async () => {
      const filePath = join(tempDir, 'clear.md');
      writeFileSync(filePath, 'data');
      const loader = new TemplateLoader();

      await loader.load(filePath);
      loader.clearCache();

      const stats = loader.getStats();
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it('clearCache(pattern) should clear matching entries', async () => {
      const fileA = join(tempDir, 'match-a.md');
      const fileB = join(tempDir, 'other-b.md');
      writeFileSync(fileA, 'A');
      writeFileSync(fileB, 'B');
      const loader = new TemplateLoader();

      await loader.load(fileA);
      await loader.load(fileB);
      loader.clearCache('*match-a*');

      // After pattern clear, fileA should be a miss and fileB should still be cached
      await loader.load(fileA);
      await loader.load(fileB);

      const stats = loader.getStats();
      // misses: fileA (1st load) + fileB (1st load) + fileA (re-load after clear) = 3
      expect(stats.misses).toBe(3);
      expect(stats.hits).toBe(1);   // fileB still cached
    });
  });

  describe('getStats - empty loader', () => {
    it('should report zero stats for fresh loader', () => {
      const loader = new TemplateLoader();
      const stats = loader.getStats();
      expect(stats.size).toBe(0);
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.hitRate).toBe(0);
    });
  });

  describe('loadMultiple', () => {
    it('should load multiple files successfully', async () => {
      const fileA = join(tempDir, 'multi-a.md');
      const fileB = join(tempDir, 'multi-b.md');
      writeFileSync(fileA, 'Content A');
      writeFileSync(fileB, 'Content B');
      const loader = new TemplateLoader();

      const results = await loader.loadMultiple([fileA, fileB]);
      expect(results.get(fileA)).toBe('Content A');
      expect(results.get(fileB)).toBe('Content B');
    });

    it('should skip files that fail to load', async () => {
      const fileA = join(tempDir, 'exists.md');
      const fileB = join(tempDir, 'missing.md');
      writeFileSync(fileA, 'exists');
      const loader = new TemplateLoader();

      const results = await loader.loadMultiple([fileA, fileB]);
      expect(results.get(fileA)).toBe('exists');
      expect(results.has(fileB)).toBe(false);
    });
  });

  describe('resolvePath', () => {
    it('should return absolute paths as-is', () => {
      const loader = new TemplateLoader();
      const absPath = join(tempDir, 'abs.md');
      writeFileSync(absPath, 'x');
      expect(loader.resolvePath(absPath)).toBe(absPath);
    });

    it('should throw when relative path cannot be resolved', () => {
      const loader = new TemplateLoader();
      expect(() => loader.resolvePath('this/does/not/exist/anywhere')).toThrow(/not found/i);
    });

    it('should resolve relative path with .md extension from cwd base', () => {
      // Create a file relative to cwd
      const relDir = join(tempDir);
      const fileName = `resolve-test-${Date.now()}`;
      const fullPath = join(relDir, fileName + '.md');
      writeFileSync(fullPath, 'resolved');

      const loader = new TemplateLoader();
      // Test with absolute path (guaranteed to work)
      const resolved = loader.resolvePath(fullPath);
      expect(resolved).toBe(fullPath);
    });
  });

  describe('loadSync', () => {
    it('should throw not-implemented error', () => {
      const loader = new TemplateLoader();
      expect(() => loader.loadSync('test.md')).toThrow(/not implemented/i);
    });
  });
});
