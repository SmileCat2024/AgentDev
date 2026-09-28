/**
 * 后台任务渲染模板测试
 *
 * 覆盖三类契约：
 * - bash.render：bg-started display 载荷渲染任务卡；前台输出仍走 bash-output；
 *   调用参数 chips 只在传入时出现。
 * - bg-list / bg-status：display 结构化渲染 + 无 display 的纯文本回退（历史会话）。
 * - bg（小操作）：确认文本普通字体呈现，可预期失败前缀转警示色。
 * - 外部数据（命令、任务号、输出）一律 HTML 转义。
 */

import { describe, it, expect } from 'vitest';
import bashRender from '../src/templates/bash.render.js';
import bgRender from '../src/templates/bg.render.js';
import bgListRender from '../src/templates/bg-list.render.js';
import bgStatusRender from '../src/templates/bg-status.render.js';

const BG_STARTED = {
  kind: 'bg-started',
  taskId: 'bg-1',
  command: 'npm run build',
  intervalSec: 90,
  quietAfterSec: 60,
};

describe('bash.render', () => {
  it('renders bg-started display as a task card', () => {
    const html = (bashRender.result as Function)(BG_STARTED, true);
    expect(html).toContain('tool-bg-id');
    expect(html).toContain('bg-1');
    expect(html).toContain('$ npm run build');
    expect(html).toContain('每 90s 汇报');
    expect(html).not.toContain('静默');
    expect(html).not.toContain('无需轮询等待');
    expect(html).not.toContain('bash-output');
  });

  it('keeps foreground output as pre text', () => {
    const html = (bashRender.result as Function)('ok\n1 file changed', true);
    expect(html).toContain('bash-output');
    expect(html).toContain('1 file changed');
  });

  it('renders call chips only when bg params are present', () => {
    const withChips = (bashRender.call as Function)({ command: 'x', intervalSec: 300, quietAfterSec: 30 });
    expect(withChips).toContain('tool-chip');
    expect(withChips).toContain('每 300s 汇报');
    const plain = (bashRender.call as Function)({ command: 'x' });
    expect(plain).not.toContain('tool-chip');
  });

  it('escapes command content', () => {
    const html = (bashRender.result as Function)({ ...BG_STARTED, command: '<script>&amp;</script>' }, true);
    expect(html).toContain('&lt;script&gt;&amp;amp;&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
});

describe('bg-list.render', () => {
  const DISPLAY = {
    kind: 'bg-list',
    running: 1,
    total: 2,
    tasks: [
      { id: 'bg-1', status: 'running', command: 'npm run dev', durationMs: 83_000, quietMs: 12_000, exitCode: null, intervalSec: 90, quietAfterSec: 60, inheritedPace: false, nextReportInMs: 47_000 },
      { id: 'bg-2', status: 'done', command: 'npm test', durationMs: 5_000, quietMs: 0, exitCode: 1, intervalSec: 90, quietAfterSec: 60, inheritedPace: false, nextReportInMs: null },
    ],
  };

  it('renders structured task rows', () => {
    const html = (bgListRender.result as Function)(DISPLAY, true);
    expect(html).toContain('tool-bg-tasks');
    expect(html).toContain('运行中');
    expect(html).toContain('已运行 1m23s');
    expect(html).toContain('退出码 1');
    expect(html).toContain('1 运行中 / 2 总计');
  });

  it('falls back to plain text for legacy string results', () => {
    const html = (bgListRender.result as Function)('当前没有后台任务。', true);
    expect(html).toContain('tool-plain-text');
    expect(html).toContain('当前没有后台任务');
  });
});

describe('bg-status.render', () => {
  const DISPLAY = {
    kind: 'bg-status',
    taskId: 'bg-1',
    status: 'running',
    durationMs: 83_000,
    exitCode: null,
    quietMs: 12_000,
    nextReportInMs: 47_000,
    command: 'npm run dev',
    newOutput: 'listening on 1420',
    outputTruncated: false,
    clamped: false,
  };

  it('renders status head, command and new output', () => {
    const html = (bgStatusRender.result as Function)(DISPLAY, true);
    expect(html).toContain('bg-1');
    expect(html).toContain('运行中');
    expect(html).toContain('$ npm run dev');
    expect(html).toContain('新增输出');
    expect(html).toContain('listening on 1420');
  });

  it('shows empty-output note when no new output', () => {
    const html = (bgStatusRender.result as Function)({ ...DISPLAY, newOutput: '' }, true);
    expect(html).toContain('无新增输出');
  });

  it('falls back to plain text for missing task (legacy path)', () => {
    const html = (bgStatusRender.result as Function)('未找到后台任务 bg-9。用 bg_list 查看现有任务。', true);
    expect(html).toContain('warn');
    expect(html).toContain('未找到后台任务');
  });
});

describe('bg.render (small ops)', () => {
  it('renders bg_write stdin text as terminal input', () => {
    const html = (bgRender.call as Function)({ taskId: 'bg-1', text: 'hello demo\nsecond line' });
    expect(html).toContain('bash-command');
    expect(html).toContain('&gt; hello demo');
    expect(html).toContain('stdin → bg-1');
  });

  it('renders taskId call with param chips', () => {
    const html = (bgRender.call as Function)({ taskId: 'bg-1', afterSec: 60 });
    expect(html).toContain('bg-1');
    expect(html).toContain('afterSec=60s');
  });

  it('renders confirmation as plain text', () => {
    const html = (bgRender.result as Function)('已写入 bg-1 的 stdin。', true);
    expect(html).toContain('tool-plain-text');
  });

  it('marks expected failures as warning', () => {
    const html = (bgRender.result as Function)('写入失败：bg-1 不在运行或 stdin 不可用。', true);
    expect(html).toContain('warn');
  });
});
