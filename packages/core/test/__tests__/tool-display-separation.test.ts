/**
 * withDisplay 分离机制往返测试
 *
 * 覆盖完整链路：
 * 1. withDisplay() / isWithDisplayResult() marker 工具函数
 * 2. isWithDisplayResult 与 isWithImagesResult 不交叉污染
 * 3. Context.addToolMessage() — display 透传到 Message
 * 4. Context.addSerializedToolMessage() — display 参数支持
 * 5. Message 序列化往返 — JSON.stringify/parse 保留 display
 * 6. cloneMessages() — display 保留
 * 7. 向后兼容 — 无 display 的旧消息不受影响
 * 8. write 工具 — 返回 withDisplay，LLM 只看到精简文本，diff 在 display 中
 * 9. edit 工具 — 同上
 * 10. grep 工具 — modTime 已移除，结果按 path+lineNum 排序
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withDisplay, isWithDisplayResult } from '../../src/core/tool-result-display.js';
import { withImages, isWithImagesResult } from '../../src/core/tool-result-images.js';
import { Context } from '../../src/core/context.js';
import type { ToolExecResult } from '../../src/core/context.js';
import type { ToolCall } from '../../src/core/types.js';
import { cloneMessages } from '../../src/core/message.js';
import { createWriteTool, createEditTool, createGrepTool, createReadTool } from '../../src/features/opencode-basic/tools.js';

// ---- helpers ----

function makeToolCall(id: string, name: string): ToolCall {
  return { id, name, arguments: {} };
}

// ============================================================
// 1. withDisplay() marker 创建
// ============================================================

describe('withDisplay()', () => {
  it('should create a WithDisplayResult with marker', () => {
    const result = withDisplay('compact text', { diff: '--- a\n+++ b\n' });
    expect(result.__withDisplay).toBe(true);
    expect(result.text).toBe('compact text');
    expect(result.display).toEqual({ diff: '--- a\n+++ b\n' });
  });

  it('should accept complex display objects', () => {
    const display = { filePath: '/test.js', existed: false, diff: '@@ ...', nested: { a: 1 } };
    const result = withDisplay('{"ok":true}', display);
    expect(result.display).toEqual(display);
    expect(result.__withDisplay).toBe(true);
  });

  it('should accept null display', () => {
    const result = withDisplay('text', null);
    expect(result.__withDisplay).toBe(true);
    expect(result.display).toBeNull();
  });
});

// ============================================================
// 2. isWithDisplayResult() type guard
// ============================================================

describe('isWithDisplayResult()', () => {
  it('should return true for withDisplay() output', () => {
    expect(isWithDisplayResult(withDisplay('test', { a: 1 }))).toBe(true);
  });

  it('should return false for plain objects', () => {
    expect(isWithDisplayResult({ text: 'nope' })).toBe(false);
    expect(isWithDisplayResult({})).toBe(false);
    expect(isWithDisplayResult(null)).toBe(false);
    expect(isWithDisplayResult(undefined)).toBe(false);
    expect(isWithDisplayResult('string')).toBe(false);
    expect(isWithDisplayResult(42)).toBe(false);
    expect(isWithDisplayResult([])).toBe(false);
  });

  it('should return false for manually constructed fake markers', () => {
    expect(isWithDisplayResult({ __withDisplay: 'true', text: 'x', display: {} })).toBe(false);
    expect(isWithDisplayResult({ __withDisplay: 1, text: 'x', display: {} })).toBe(false);
  });

  it('should not cross-contaminate with isWithImagesResult', () => {
    // withDisplay output should NOT be recognized as withImages
    const displayResult = withDisplay('text', { diff: 'x' });
    expect(isWithImagesResult(displayResult)).toBe(false);

    // withImages output should NOT be recognized as withDisplay
    const imagesResult = withImages('text', [{ base64: 'abc', mediaType: 'image/png', source: 'test.png' }]);
    expect(isWithDisplayResult(imagesResult)).toBe(false);
  });
});

// ============================================================
// 3. Context.addToolMessage() — display 透传
// ============================================================

describe('Context.addToolMessage() with display', () => {
  it('should store display on the Message', () => {
    const ctx = new Context();
    const call = makeToolCall('call_1', 'write');
    const result: ToolExecResult = {
      success: true,
      result: '{"filePath":"/test.js","existed":false,"lines":10,"message":"File created successfully"}',
      display: { filePath: '/test.js', existed: false, diff: '@@ diff content @@' },
    };
    ctx.addToolMessage(call, result, 1);

    const msgs = ctx.getAll();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('tool');
    expect(msgs[0].display).toEqual({ filePath: '/test.js', existed: false, diff: '@@ diff content @@' });
  });

  it('should NOT include display data in content (LLM only sees compact text)', () => {
    const ctx = new Context();
    const call = makeToolCall('call_2', 'write');
    const compactText = '{"message":"File created successfully"}';
    const result: ToolExecResult = {
      success: true,
      result: compactText,
      display: { diff: 'very long diff that should NOT be in content' },
    };
    ctx.addToolMessage(call, result, 1);

    const msgs = ctx.getAll();
    const content = JSON.parse(msgs[0].content);
    expect(content.result).toBe(compactText);
    // diff must NOT leak into content
    expect(msgs[0].content).not.toContain('very long diff');
  });

  it('should omit display field entirely when not provided', () => {
    const ctx = new Context();
    const call = makeToolCall('call_3', 'bash');
    const result: ToolExecResult = {
      success: true,
      result: 'command output',
    };
    ctx.addToolMessage(call, result, 1);

    const msgs = ctx.getAll();
    expect(msgs[0].display).toBeUndefined();
  });
});

// ============================================================
// 4. Context.addSerializedToolMessage() — display 参数
// ============================================================

describe('Context.addSerializedToolMessage() with display', () => {
  it('should store display when provided', () => {
    const ctx = new Context();
    const content = JSON.stringify({ success: true, result: '{"ok":true}' });
    const display = { diff: 'sample diff' };
    ctx.addSerializedToolMessage('call_x', content, 0, undefined, display);

    const msgs = ctx.getAll();
    expect(msgs[0].display).toEqual(display);
  });

  it('should omit display when not provided', () => {
    const ctx = new Context();
    const content = JSON.stringify({ success: true, result: '{"ok":true}' });
    ctx.addSerializedToolMessage('call_y', content, 0);

    const msgs = ctx.getAll();
    expect(msgs[0].display).toBeUndefined();
  });

  it('should support both images and display simultaneously', () => {
    const ctx = new Context();
    const content = JSON.stringify({ success: true, result: '{"ok":true}' });
    const images = [{ base64: 'abc', mediaType: 'image/png', source: 'test.png' }];
    const display = { diff: 'diff content' };
    ctx.addSerializedToolMessage('call_z', content, 0, images, display);

    const msgs = ctx.getAll();
    expect(msgs[0].images).toEqual(images);
    expect(msgs[0].display).toEqual(display);
  });
});

// ============================================================
// 5. Message 序列化往返 — JSON 保留 display
// ============================================================

describe('Message serialization round-trip', () => {
  it('should preserve display through JSON.stringify/parse', () => {
    const ctx = new Context();
    const call = makeToolCall('call_rt', 'write');
    const result: ToolExecResult = {
      success: true,
      result: '{"message":"ok"}',
      display: { filePath: '/a.js', existed: true, diff: '@@ -1 +1 @@' },
    };
    ctx.addToolMessage(call, result, 0);

    const original = ctx.getAll()[0];
    const serialized = JSON.stringify(original);
    const deserialized = JSON.parse(serialized);

    expect(deserialized.display).toEqual({ filePath: '/a.js', existed: true, diff: '@@ -1 +1 @@' });
    expect(deserialized.role).toBe('tool');
    expect(deserialized.content).toBe(original.content);
  });
});

// ============================================================
// 6. cloneMessages() — display 保留
// ============================================================

describe('cloneMessages() with display', () => {
  it('should preserve display field after cloning', () => {
    const messages = [
      {
        role: 'tool' as const,
        turn: 0,
        toolCallId: 'call_clone',
        content: '{"success":true,"result":"ok"}',
        display: { diff: 'diff data' },
      },
    ];
    const cloned = cloneMessages(messages);
    expect(cloned[0].display).toEqual({ diff: 'diff data' });
    // cloneMessages uses shallow spread ({ ...m }) by design — display is copied by reference,
    // same as images and other complex fields. This is acceptable: the consumer should not mutate.
  });
});

// ============================================================
// 7. 向后兼容 — 旧消息格式
// ============================================================

describe('backward compatibility', () => {
  it('should handle old-style ToolExecResult without display', () => {
    const ctx = new Context();
    const call = makeToolCall('call_old', 'read');
    ctx.addToolMessage(call, { success: true, result: 'file content' }, 0);

    const msg = ctx.getAll()[0];
    expect(msg.display).toBeUndefined();
    expect(JSON.parse(msg.content).result).toBe('file content');
  });

  it('should handle ToolExecResult with error and no display', () => {
    const ctx = new Context();
    const call = makeToolCall('call_err', 'bash');
    ctx.addToolMessage(call, { success: false, result: '', error: 'command failed' }, 0);

    const msg = ctx.getAll()[0];
    expect(msg.display).toBeUndefined();
    const content = JSON.parse(msg.content);
    expect(content.success).toBe(false);
    expect(content.error).toBe('command failed');
  });
});

// ============================================================
// 8. write 工具 — withDisplay 分离
// ============================================================

describe('write tool returns withDisplay', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentdev-write-display-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return withDisplay for new file (diff in display, not in LLM text)', async () => {
    const tool = createWriteTool(tmpDir);
    const filePath = join(tmpDir, 'new-file.js');
    const content = 'function hello() {\n  return "world";\n}\n';

    const result = await tool.execute({ filePath, content }, {} as any) as any;

    // Should be a withDisplay marker
    expect(isWithDisplayResult(result)).toBe(true);

    // LLM text: compact, contains message but NOT the diff
    const llmText = JSON.parse(result.text);
    expect(llmText.message).toContain('created successfully');
    expect(llmText.lines).toBe(4); // line count
    expect(result.text).not.toContain('function hello');
    expect(result.text).not.toContain('Index:');
    expect(result.text).not.toContain('+++');

    // Display: contains the diff for frontend rendering
    expect(result.display.diff).toContain('function hello');
    expect(result.display.existed).toBe(false);
    expect(result.display.filePath).toBe(filePath);
  });

  it('should return withDisplay for overwriting existing file', async () => {
    const tool = createWriteTool(tmpDir);
    const readTool = createReadTool(tmpDir);
    const filePath = join(tmpDir, 'existing.js');
    writeFileSync(filePath, 'old content\n');

    // Read first to satisfy dedup guard
    await readTool.execute({ filePath }, {} as any);

    const result = await tool.execute({ filePath, content: 'new content\n' }, {} as any) as any;

    expect(isWithDisplayResult(result)).toBe(true);
    expect(result.display.existed).toBe(true);
    expect(result.display.diff).toContain('-old content');
    expect(result.display.diff).toContain('+new content');

    // LLM text should not contain old content
    expect(result.text).not.toContain('old content');
  });
});

// ============================================================
// 9. edit 工具 — withDisplay 分离
// ============================================================

describe('edit tool returns withDisplay', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentdev-edit-display-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return withDisplay (diff in display, stats in LLM text)', async () => {
    const tool = createEditTool(tmpDir);
    const readTool = createReadTool(tmpDir);
    const filePath = join(tmpDir, 'edit-target.js');
    writeFileSync(filePath, 'const x = 1;\nconst y = 2;\n');

    // Read first to satisfy dedup guard
    await readTool.execute({ filePath }, {} as any);

    const result = await tool.execute({
      filePath,
      oldString: 'const x = 1;',
      newString: 'const x = 42;',
    }, {} as any) as any;

    expect(isWithDisplayResult(result)).toBe(true);

    // LLM text: contains stats but NOT the diff
    const llmText = JSON.parse(result.text);
    expect(llmText.additions).toBe(1);
    expect(llmText.deletions).toBe(1);
    expect(llmText.message).toContain('Edit applied');
    expect(result.text).not.toContain('const x = 42');
    expect(result.text).not.toContain('Index:');

    // Display: contains the diff
    expect(result.display.diff).toContain('const x = 42');
    expect(result.display.additions).toBe(1);
    expect(result.display.deletions).toBe(1);
  });
});

// ============================================================
// 10. grep 工具 — modTime 移除 + 排序变更
// ============================================================

describe('grep tool without modTime', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentdev-grep-notime-'));
    // Create test files
    mkdirSync(join(tmpDir, 'sub'));
    writeFileSync(join(tmpDir, 'a.js'), 'const TARGET = 1;\nconst other = 2;\nconst TARGET2 = 3;\n');
    writeFileSync(join(tmpDir, 'sub', 'b.js'), 'const TARGET = 10;\n');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should not include modTime in results', async () => {
    const tool = createGrepTool(tmpDir);
    const result = await tool.execute({
      pattern: 'TARGET',
      searchPath: tmpDir,
    }, {} as any) as any;

    expect(result.results).toBeDefined();
    expect(result.results.length).toBeGreaterThan(0);

    // No match should have a modTime field
    for (const match of result.results) {
      expect(match).not.toHaveProperty('modTime');
    }
  });

  it('should sort results by path then lineNum, not by modTime', async () => {
    const tool = createGrepTool(tmpDir);
    const result = await tool.execute({
      pattern: 'TARGET',
      searchPath: tmpDir,
    }, {} as any) as any;

    const paths = result.results.map((r: any) => r.path);
    // All results from the same file should be grouped together
    // (sorted by path first, then by lineNum within each path)
    for (let i = 1; i < paths.length; i++) {
      if (paths[i] === paths[i - 1]) continue; // same file, check lineNum below
      expect(paths[i] > paths[i - 1]).toBe(true); // different file: sorted by path
    }

    // Within same file, lineNum should be ascending
    for (let i = 1; i < result.results.length; i++) {
      if (result.results[i].path === result.results[i - 1].path) {
        expect(result.results[i].lineNum).toBeGreaterThan(result.results[i - 1].lineNum);
      }
    }
  });
});

// ============================================================
// 11. 端到端模拟：tool execute → ToolExecResult → Context → Message → 序列化
// ============================================================

describe('end-to-end round-trip simulation', () => {
  it('should preserve display through the full lifecycle', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'agentdev-e2e-'));

    try {
      // Step 1: Tool executes and returns withDisplay
      const tool = createWriteTool(tmpDir);
      const rawResult = await tool.execute(
        { filePath: join(tmpDir, 'e2e.js'), content: 'export const x = 1;\n' },
        {} as any,
      ) as any;
      expect(isWithDisplayResult(rawResult)).toBe(true);

      // Step 2: tool-executor routing (simulate the if/else branch)
      let execResult: ToolExecResult;
      if (isWithDisplayResult(rawResult)) {
        execResult = { success: true, result: rawResult.text, display: rawResult.display };
      } else {
        execResult = { success: true, result: JSON.stringify(rawResult) };
      }
      expect(execResult.display).toBeDefined();
      expect(execResult.result).not.toContain('export const x');

      // Step 3: Context stores the result
      const ctx = new Context();
      const call = makeToolCall('e2e_call', 'write');
      ctx.addToolMessage(call, execResult, 0);

      const msg = ctx.getAll()[0];
      expect(msg.display).toEqual(rawResult.display);

      // Step 4: Serialization round-trip (session save/restore)
      const serialized = JSON.stringify(msg);
      const restored = JSON.parse(serialized);
      expect(restored.display).toEqual(rawResult.display);
      expect(restored.role).toBe('tool');
      expect(restored.toolCallId).toBe('e2e_call');

      // Step 5: Verify LLM-visible content is compact
      const content = JSON.parse(restored.content);
      expect(content.success).toBe(true);
      const llmData = JSON.parse(content.result);
      expect(llmData.message).toContain('created');
      expect(llmData.lines).toBe(2);

      // Step 6: Simulate frontend parseToolResult merge
      const frontendData = { ...llmData, ...(restored.display as Record<string, unknown>) };
      expect(frontendData.diff).toBeDefined();
      expect(frontendData.diff).toContain('export const x');
      expect(frontendData.message).toContain('created');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
