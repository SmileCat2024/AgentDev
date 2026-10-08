import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { VIEWER_JS_MESSAGES } from '../src/viewer-html/js-messages.js';
import { VIEWER_JS_UI_BASE } from '../src/viewer-html/js-ui-base.js';
import { generateViewerHtml } from '../src/viewer-html/index.js';

/**
 * 工具调用改写标注渲染测试（ADR-0023 / PR-3）
 *
 * viewer-html 的渲染函数定义在模板字符串中（浏览器全局作用域），
 * 沿用 viewer-html-inspector-roundtrip 的 vm 沙箱模式加载后调用。
 * VIEWER_JS_MESSAGES 尾部的初始化调用依赖完整页面环境，在沙箱中
 * 预期抛错——函数声明在此之前已完成。
 */

function createMessagesSandbox(): Record<string, any> {
  const sandbox: Record<string, any> = {
    window: {},
    document: {
      getElementById: () => ({ classList: { toggle: () => {} } }),
    },
    t: (key: string) => key,
    escapeHtml: (s: unknown) => String(s),
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext(VIEWER_JS_MESSAGES, sandbox);
  } catch {
    // 初始化尾部调用（applyTheme 等）在沙箱中失败，函数声明已完成
  }
  return sandbox;
}

const REWRITTEN = { name: 'read_file', arguments: { path: './a.ts' } };

describe('viewer 工具调用改写标注（ADR-0023）', () => {
  it('getRewrittenCall：合法 display 返回原始调用快照，缺失或畸形返回 null', () => {
    const sandbox = createMessagesSandbox();
    expect(sandbox.getRewrittenCall({ rewrittenCall: REWRITTEN })).toEqual(REWRITTEN);
    expect(sandbox.getRewrittenCall({})).toBeNull();
    expect(sandbox.getRewrittenCall({ rewrittenCall: 'garbage' })).toBeNull();
    expect(sandbox.getRewrittenCall(undefined)).toBeNull();
  });

  it('renderRewriteBadge：携带改写时渲染徽章（类名 + i18n 文案 + toggle 事件），否则为空', () => {
    const sandbox = createMessagesSandbox();
    const badge = sandbox.renderRewriteBadge('rw-msg-1', REWRITTEN);
    expect(badge).toContain('tool-rewrite-badge');
    expect(badge).toContain('tool_rewritten');
    expect(badge).toContain("toggleRewriteDetail('rw-msg-1')");
    expect(sandbox.renderRewriteBadge('rw-msg-1', null)).toBe('');
  });

  it('renderRewriteDetail：展开块含原始调用名与参数 JSON，否则为空', () => {
    const sandbox = createMessagesSandbox();
    const detail = sandbox.renderRewriteDetail('rw-msg-1', REWRITTEN);
    expect(detail).toContain('id="rw-msg-1"');
    expect(detail).toContain('tool-rewrite-detail');
    expect(detail).toContain('read_file');
    expect(detail).toContain('./a.ts');
    expect(sandbox.renderRewriteDetail('rw-msg-1', null)).toBe('');
  });

  it('toggleRewriteDetail：切换展开类', () => {
    const toggled: string[] = [];
    const sandbox: Record<string, any> = {
      window: {},
      document: {
        getElementById: () => ({ classList: { toggle: (cls: string) => toggled.push(cls) } }),
      },
      t: (key: string) => key,
      escapeHtml: (s: unknown) => String(s),
    };
    vm.createContext(sandbox);
    try {
      vm.runInContext(VIEWER_JS_MESSAGES, sandbox);
    } catch {
      // 同上：初始化尾部调用预期失败
    }
    sandbox.window.toggleRewriteDetail('rw-msg-1');
    expect(toggled).toEqual(['expanded']);
  });

  it('refreshRewriteIndex：从 tool 消息 display 建 callId 索引，重入刷新不残留', () => {
    const sandbox = createMessagesSandbox();
    sandbox.refreshRewriteIndex([
      { role: 'assistant', toolCalls: [{ id: 'c1', name: 'read_file', arguments: {} }] },
      { role: 'tool', toolCallId: 'c1', display: { rewrittenCall: REWRITTEN }, content: '{}' },
      { role: 'tool', toolCallId: 'c2', display: {}, content: '{}' },
    ]);
    expect(sandbox.rewrittenByCallId.get('c1')).toEqual(REWRITTEN);
    expect(sandbox.rewrittenByCallId.has('c2')).toBe(false);
    sandbox.refreshRewriteIndex([]);
    expect(sandbox.rewrittenByCallId.size).toBe(0);
  });

  it('rewriteDetailId：callId 清洗为安全 DOM id', () => {
    const sandbox = createMessagesSandbox();
    expect(sandbox.rewriteDetailId('call-abc_1')).toBe('rw-call-call-abc_1');
    expect(sandbox.rewriteDetailId('x:y/z')).toBe('rw-call-x_y_z');
  });

  it('parseToolResult：rewrittenCall 不并入结果数据（标注元数据单独渲染）', () => {
    const sandbox: Record<string, any> = {};
    vm.createContext(sandbox);
    try {
      // 模板顶部有 DOM 访问（sidebarToggle 等），沙箱中预期抛错；
      // parseToolResult 为函数声明，已提升完成
      vm.runInContext(VIEWER_JS_UI_BASE, sandbox);
    } catch {
      // 预期失败
    }

    expect(typeof sandbox.parseToolResult).toBe('function');
    const { success, data } = sandbox.parseToolResult(
      JSON.stringify({ success: true, result: { filePath: 'a.ts' } }),
      { rewrittenCall: REWRITTEN, diff: '+x' },
    );
    expect(success).toBe(true);
    expect(data).toMatchObject({ filePath: 'a.ts', diff: '+x' });
    expect(data.rewrittenCall).toBeUndefined();
  });

  it('完整页面模板包含标注样式与渲染函数（集成冒烟）', () => {
    const html = generateViewerHtml(2026);
    expect(html).toContain('.tool-rewrite-badge');
    expect(html).toContain('getRewrittenCall');
    expect(html).toContain('tool_rewritten');
    // 徽章挂在调用块：调用容器携带 callId 锚点，渲染期建索引 + 分批补装
    expect(html).toContain('data-tool-call-id');
    expect(html).toContain('refreshRewriteIndex');
    expect(html).toContain('retrofitRewriteBadgeOnCallBlock');
    // M-1 回归守卫：折叠逻辑以类名取工具名，不依赖 span 位置（徽章不再是 last child 的隐患）
    expect(html).toContain('tool-result-name');
    expect(html).toContain('.tool-result-header .tool-result-name');
  });
});
