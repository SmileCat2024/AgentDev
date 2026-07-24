import { describe, it, expect } from 'vitest';
import {
  interpolateTemplate,
  applyTemplate,
  getToolRenderConfig,
  getToolRenderTemplate,
  getToolDisplayName,
  RENDER_TEMPLATES,
} from '../../core/render.js';

// ============= interpolateTemplate =============

describe('interpolateTemplate', () => {
  it('should replace {{key}} placeholders', () => {
    const result = interpolateTemplate('Hello {{name}}!', { name: 'World' });
    expect(result).toBe('Hello World!');
  });

  it('should keep placeholder as-is when key is missing', () => {
    const result = interpolateTemplate('Hello {{name}}!', {});
    expect(result).toBe('Hello {{name}}!');
  });

  it('should keep placeholder as-is when value is undefined', () => {
    const result = interpolateTemplate('Hello {{name}}!', { name: undefined });
    expect(result).toBe('Hello {{name}}!');
  });

  it('should handle multiple placeholders', () => {
    const result = interpolateTemplate('{{a}} + {{b}} = {{c}}', { a: '1', b: '2', c: '3' });
    expect(result).toBe('1 + 2 = 3');
  });

  it('should return original string when no placeholders', () => {
    const result = interpolateTemplate('plain text', {});
    expect(result).toBe('plain text');
  });

  it('should coerce non-string values to string', () => {
    const result = interpolateTemplate('count: {{n}}', { n: 42 });
    expect(result).toBe('count: 42');
  });
});

// ============= applyTemplate =============

describe('applyTemplate', () => {
  it('should use interpolateTemplate for string templates', () => {
    const result = applyTemplate('Hello {{name}}', { name: 'World' });
    expect(result).toBe('Hello World');
  });

  it('should call function templates directly', () => {
    const fn = (data: Record<string, any>) => `Value: ${data.x}`;
    const result = applyTemplate(fn, { x: 10 });
    expect(result).toBe('Value: 10');
  });

  it('should pass data and success to function templates', () => {
    const fn = (data: Record<string, any>, success?: boolean) =>
      `${data.x}-${success}`;
    expect(applyTemplate(fn, { x: 1 }, true)).toBe('1-true');
    expect(applyTemplate(fn, { x: 1 }, false)).toBe('1-false');
    expect(applyTemplate(fn, { x: 1 })).toBe('1-true');
  });
});

// ============= getToolRenderConfig =============

describe('getToolRenderConfig', () => {
  it('should use system default mapping when no custom config', () => {
    const config = getToolRenderConfig('read_file');
    expect(config.call).toBe('file');
    expect(config.result).toBe('file');
  });

  it('should fallback to json for unmapped tools', () => {
    const config = getToolRenderConfig('unknown_tool');
    expect(config.call).toBe('json');
    expect(config.result).toBe('json');
  });

  it('should override with custom config', () => {
    const config = getToolRenderConfig('read_file', { call: 'command', result: 'web' });
    expect(config.call).toBe('command');
    expect(config.result).toBe('web');
  });

  it('should handle partial custom config (call only)', () => {
    const config = getToolRenderConfig('read_file', { call: 'command' });
    expect(config.call).toBe('command');
    // result falls back to system default
    expect(config.result).toBe('file');
  });

  it('should handle partial custom config (result only)', () => {
    const config = getToolRenderConfig('read_file', { result: 'web' });
    expect(config.call).toBe('file');
    expect(config.result).toBe('web');
  });
});

// ============= getToolRenderTemplate =============

describe('getToolRenderTemplate', () => {
  it('should resolve string reference to RENDER_TEMPLATES entry', () => {
    const template = getToolRenderTemplate('read_file');
    expect(template.call).toBe(RENDER_TEMPLATES['file'].call);
    expect(template.result).toBe(RENDER_TEMPLATES['file'].result);
  });

  it('should fallback to json for unmapped tools', () => {
    const template = getToolRenderTemplate('totally_unknown');
    expect(template.call).toBe(RENDER_TEMPLATES['json'].call);
    expect(template.result).toBe(RENDER_TEMPLATES['json'].result);
  });

  it('should use inline template object when provided', () => {
    const inlineCall = (data: Record<string, any>) => `custom-call:${data.x}`;
    const inlineResult = (data: Record<string, any>) => `custom-result:${data.x}`;
    const template = getToolRenderTemplate('read_file', {
      call: { call: inlineCall, result: inlineResult },
      result: { call: inlineCall, result: inlineResult },
    });
    expect(template.call).toBe(inlineCall);
    expect(template.result).toBe(inlineResult);
  });

  it('should resolve inline call with inline result separately', () => {
    const callFn = (data: Record<string, any>) => `call:${data.x}`;
    const resultFn = (data: Record<string, any>) => `result:${data.x}`;
    const template = getToolRenderTemplate('read_file', {
      call: { call: callFn, result: resultFn },
      result: { call: callFn, result: resultFn },
    });
    expect(typeof template.call).toBe('function');
    expect(typeof template.result).toBe('function');
  });

  it('should fallback to json template name when reference does not exist', () => {
    const template = getToolRenderTemplate('unknown', { call: 'nonexistent_template' });
    // call: nonexistent_template not in RENDER_TEMPLATES -> fallback to json
    expect(template.call).toBe(RENDER_TEMPLATES['json'].call);
  });
});

// ============= getToolDisplayName =============

describe('getToolDisplayName', () => {
  it('should return display name for known tools', () => {
    expect(getToolDisplayName('bash')).toBe('Bash');
    expect(getToolDisplayName('read')).toBe('Read');
    expect(getToolDisplayName('write')).toBe('Write');
    expect(getToolDisplayName('edit')).toBe('Edit');
    expect(getToolDisplayName('glob')).toBe('Glob');
    expect(getToolDisplayName('grep')).toBe('Grep');
    expect(getToolDisplayName('ls')).toBe('LS');
    expect(getToolDisplayName('web_fetch')).toBe('Web');
    expect(getToolDisplayName('calculator')).toBe('Calc');
    expect(getToolDisplayName('invoke_skill')).toBe('Invoke Skill');
    expect(getToolDisplayName('safe_trash_delete')).toBe('Safe Delete');
  });

  it('should return original name for unknown tools', () => {
    expect(getToolDisplayName('unknown_tool')).toBe('unknown_tool');
  });
});

// ============= RENDER_TEMPLATES function templates =============

describe('RENDER_TEMPLATES function templates', () => {
  // ---- escapeHtml (tested indirectly) ----

  it('file result should HTML-escape data', () => {
    const result = RENDER_TEMPLATES['file'].result as Function;
    expect(result('<script>alert(1)</script>')).toContain('&lt;script&gt;');
    expect(result('<script>alert(1)</script>')).not.toContain('<script>');
  });

  it('file result should escape ampersands', () => {
    const result = RENDER_TEMPLATES['file'].result as Function;
    expect(result('a & b')).toContain('&amp;');
  });

  // ---- command result ----

  it('command result should HTML-escape data', () => {
    const result = RENDER_TEMPLATES['command'].result as Function;
    const html = result('<b>bold</b>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>');
  });

  // ---- json templates ----

  it('json call should stringify args', () => {
    const call = RENDER_TEMPLATES['json'].call as Function;
    const html = call({ key: 'value' });
    expect(html).toContain('&quot;key&quot;');
    expect(html).toContain('&quot;value&quot;');
  });

  it('json result should stringify object data', () => {
    const result = RENDER_TEMPLATES['json'].result as Function;
    const html = result({ nested: true });
    expect(html).toContain('&quot;nested&quot;');
    expect(html).toContain('true');
  });

  it('json result should pass through string data', () => {
    const result = RENDER_TEMPLATES['json'].result as Function;
    const html = result('plain string');
    expect(html).toContain('plain string');
  });

  // ---- trash-delete ----

  it('trash-delete call should handle array paths', () => {
    const call = RENDER_TEMPLATES['trash-delete'].call as Function;
    const html = call({ paths: ['/a/b', '/c/d'] });
    expect(html).toContain('/a/b');
    expect(html).toContain('/c/d');
  });

  it('trash-delete call should handle single string path', () => {
    const call = RENDER_TEMPLATES['trash-delete'].call as Function;
    const html = call({ paths: '/single/path' });
    expect(html).toContain('/single/path');
  });

  it('trash-delete call should show "+N more" for more than 3 paths', () => {
    const call = RENDER_TEMPLATES['trash-delete'].call as Function;
    const html = call({ paths: ['a', 'b', 'c', 'd', 'e'] });
    expect(html).toContain('+2 more');
  });

  it('trash-delete call should not show "+N more" for exactly 3 paths', () => {
    const call = RENDER_TEMPLATES['trash-delete'].call as Function;
    const html = call({ paths: ['a', 'b', 'c'] });
    expect(html).not.toContain('more');
  });

  it('trash-delete result should show all-success message', () => {
    const result = RENDER_TEMPLATES['trash-delete'].result as Function;
    const html = result({ moved_count: 3, failed: [] });
    expect(html).toContain('✓');
    expect(html).toContain('3 item(s)');
  });

  it('trash-delete result should show partial-failure warning', () => {
    const result = RENDER_TEMPLATES['trash-delete'].result as Function;
    const html = result({ moved_count: 2, failed: [{ path: 'x', error: 'err' }] });
    expect(html).toContain('⚠');
    expect(html).toContain('2');
    expect(html).toContain('1 failed');
  });

  it('trash-delete result should show nothing-moved message', () => {
    const result = RENDER_TEMPLATES['trash-delete'].result as Function;
    const html = result({ moved_count: 0, failed: [] });
    expect(html).toContain('No files moved');
  });

  // ---- trash-list ----

  it('trash-list result should show empty message when total is 0', () => {
    const result = RENDER_TEMPLATES['trash-list'].result as Function;
    const html = result({ total: 0 });
    expect(html).toContain('Trash is empty');
  });

  it('trash-list result should show count when trash is not empty', () => {
    const result = RENDER_TEMPLATES['trash-list'].result as Function;
    const html = result({ total: 5 });
    expect(html).toContain('5 item(s)');
  });

  // ---- trash-restore ----

  it('trash-restore call should escape target', () => {
    const call = RENDER_TEMPLATES['trash-restore'].call as Function;
    const html = call({ target: '<x>' });
    expect(html).toContain('&lt;x&gt;');
    expect(html).not.toContain('<x>');
  });

  it('trash-restore result should show all-success message', () => {
    const result = RENDER_TEMPLATES['trash-restore'].result as Function;
    const html = result({ restored: ['a', 'b'], failed: [] });
    expect(html).toContain('✓');
    expect(html).toContain('2 item(s)');
  });

  it('trash-restore result should show partial-failure message', () => {
    const result = RENDER_TEMPLATES['trash-restore'].result as Function;
    const html = result({ restored: ['a'], failed: [{ error: 'err' }] });
    expect(html).toContain('Restored 1');
    expect(html).toContain('1 failed');
  });

  it('trash-restore result should show nothing-restored message', () => {
    const result = RENDER_TEMPLATES['trash-restore'].result as Function;
    const html = result({ restored: [], failed: [] });
    expect(html).toContain('Nothing restored');
  });

  // ---- agent-spawn ----

  it('agent-spawn result should show success message', () => {
    const result = RENDER_TEMPLATES['agent-spawn'].result as Function;
    const html = result({ agentId: 'agent-1', type: 'worker' });
    expect(html).toContain('✓');
    expect(html).toContain('agent-1');
    expect(html).toContain('worker');
  });

  it('agent-spawn result should show error message', () => {
    const result = RENDER_TEMPLATES['agent-spawn'].result as Function;
    const html = result({ error: 'spawn failed' });
    expect(html).toContain('✗');
    expect(html).toContain('spawn failed');
  });

  // ---- agent-list ----

  it('agent-list result should show empty message', () => {
    const result = RENDER_TEMPLATES['agent-list'].result as Function;
    const html = result({ agents: [], total: 0, running: 0 });
    expect(html).toContain('No agents found');
  });

  it('agent-list result should show summary', () => {
    const result = RENDER_TEMPLATES['agent-list'].result as Function;
    const html = result({ agents: [{ id: 'a' }, { id: 'b' }], total: 2, running: 1 });
    expect(html).toContain('Total: 2');
    expect(html).toContain('Running: 1');
  });

  // ---- agent-send ----

  it('agent-send result should show success message', () => {
    const result = RENDER_TEMPLATES['agent-send'].result as Function;
    const html = result({});
    expect(html).toContain('✓');
    expect(html).toContain('Message sent');
  });

  it('agent-send result should show error message', () => {
    const result = RENDER_TEMPLATES['agent-send'].result as Function;
    const html = result({ error: 'send failed' });
    expect(html).toContain('✗');
    expect(html).toContain('send failed');
  });

  // ---- agent-close ----

  it('agent-close result should show success message', () => {
    const result = RENDER_TEMPLATES['agent-close'].result as Function;
    const html = result({ message: 'closed' });
    expect(html).toContain('✓');
    expect(html).toContain('closed');
  });

  it('agent-close result should show error message', () => {
    const result = RENDER_TEMPLATES['agent-close'].result as Function;
    const html = result({ error: 'close failed' });
    expect(html).toContain('✗');
    expect(html).toContain('close failed');
  });

  // ---- web ----

  it('web result should show fetched char count', () => {
    const result = RENDER_TEMPLATES['web'].result as Function;
    const html = result('hello world');
    expect(html).toContain('11 chars');
  });

  // ---- math ----

  it('math result should escape and show result', () => {
    const result = RENDER_TEMPLATES['math'].result as Function;
    const html = result('42');
    expect(html).toContain('42');
  });

  // ---- skill ----

  it('skill result should escape data', () => {
    const result = RENDER_TEMPLATES['skill'].result as Function;
    const html = result('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  // ---- file-list ----

  it('file-list result should split newlines into grid items', () => {
    const result = RENDER_TEMPLATES['file-list'].result as Function;
    const html = result('file1\nfile2\nfile3');
    expect(html).toContain('file1');
    expect(html).toContain('file2');
    expect(html).toContain('file3');
  });

  it('file-list result should handle empty data', () => {
    const result = RENDER_TEMPLATES['file-list'].result as Function;
    const html = result('');
    expect(html).toContain('grid');
  });

  it('file-list result should escape filenames', () => {
    const result = RENDER_TEMPLATES['file-list'].result as Function;
    const html = result('<evil>.txt');
    expect(html).toContain('&lt;evil&gt;');
    expect(html).not.toContain('<evil>');
  });

  // ---- file-write ----

  it('file-write result should show success message', () => {
    const result = RENDER_TEMPLATES['file-write'].result as Function;
    const html = result({});
    expect(html).toContain('✓');
    expect(html).toContain('written successfully');
  });
});
