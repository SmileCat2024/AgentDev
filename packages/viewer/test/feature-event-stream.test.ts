/**
 * Feature Event Stream v1 契约（工作项 C：观测外露数据层）
 *
 * 所有 feature 维度事件必须以结构化日志进入 viewer-worker 的 session.logs，
 * 使 filterDebuggerLogs({ feature }) 能返回该 feature 的完整时间序事件流——
 * "写第一个 feature 的 15 分钟全程可见"的数据层保证。
 *
 * 字段契约（一次定对，不丢不乱）：
 *
 * context 层（LogContextRef，可被 queryLogs 过滤）：
 *   feature: string          — 所有事件必填
 *   lifecycle?: string       — hook.invoked 事件
 *   hookMethod?: string      — hook.invoked 事件
 *   hookKind?: string        — hook.invoked 事件（observe/guard/transform）
 *   toolName?: string        — tool.executed / 工具状态变更事件
 *
 * data 层（事件细节，可被 search）：
 *   event: 事件类型枚举（见下方 EVENT_TYPES）
 *   durationMs?: number      — feature.reloaded / tool.executed
 *   reason?: string          — feature.reload_reverted 的失败阶段
 *   action?: string          — tool_state_changed: enabled|disabled|removed
 *   toolCount?: number       — mounted/removed/reloaded 的工具计数
 *
 * 事件类型：
 *   feature.mounted | feature.removed | feature.reloaded
 *   feature.reload_reverted | feature.tool_state_changed
 *   hook.invoked | tool.executed
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { DebugHub } from '../core/debug-hub.js';
import { ViewerWorker } from '../core/viewer-worker.js';
import { Agent } from '../core/agent.js';
import { filterDebuggerLogs } from '../core/debugger-mcp.js';
import type { DebugLogEntry } from '../core/types.js';

const EVENT_TYPES = [
  'feature.mounted', 'feature.removed', 'feature.reloaded',
  'feature.reload_reverted', 'feature.tool_state_changed', 'feature.hook_state_changed',
  'hook.invoked', 'tool.executed',
] as const;

// ── 测试基建（镜像 logging-delivery.test.ts 的真实管道）──

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-feature-events-${process.pid}-${Date.now()}`;
  }
  return `/tmp/agentdev-feature-events-${process.pid}-${Date.now()}.sock`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

/** 一轮工具调用 + 一轮纯文本收尾的 mock LLM */
class OneToolCallLLM {
  callCount = 0;
  modelName = 'mock-model';
  async chat(_messages: unknown, _tools: unknown): Promise<unknown> {
    this.callCount++;
    if (this.callCount === 1) {
      return {
        content: 'Calling the test tool.',
        toolCalls: [{ id: 'tc_1', name: 'stream_tool', arguments: { x: 1 } }],
      };
    }
    return { content: 'Done.' };
  }
}

/** 带 static hooks + 工具的最小 feature */
class StreamFeature {
  name = 'stream-fixture';
  static hooks = {
    onCallStart: { lifecycle: 'CallStart', kind: 'observe' },
  };
  async onCallStart(_ctx: unknown): Promise<void> {}
  getTools() {
    return [{
      name: 'stream_tool',
      description: 'stream test tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ result: 'ok' }),
    }];
  }
}

describe('feature event stream (C: observability data layer)', () => {
  const debugHub = DebugHub.getInstance();
  let worker: ViewerWorker;
  let originalUdsPath: string | undefined;
  const udsPath = getTestUdsPath();
  let agentId: string;
  let agent: Agent;
  let fixtureDir: string;

  beforeAll(async () => {
    debugHub.stop();
    originalUdsPath = process.env.AGENTDEV_UDS_PATH;
    process.env.AGENTDEV_UDS_PATH = udsPath;
    (debugHub as any).udsPath = udsPath;

    worker = new ViewerWorker(0, false, udsPath);
    await worker.start();
    await debugHub.start(0, false);

    fixtureDir = await mkdtemp(join(tmpdir(), 'agentdev-evt-'));
    await writeFile(join(fixtureDir, 'evt-v2.mjs'), `
export class EventReloadFixture {
  constructor() { this.name = 'event-reload-fixture'; this.counter = 0; }
  getTools() { return [{ name: 'evt_tool', description: 'v2', execute: async () => 'v2' }]; }
  captureState() { return { counter: this.counter }; }
  restoreState(s) { this.counter = s.counter; }
}
`, 'utf-8');
    await writeFile(join(fixtureDir, 'evt-broken.mjs'), `
export class EventReloadFixture {
  constructor() { this.name = 'event-reload-fixture'; this.counter = 0; }
  getTools() { throw new Error('broken on purpose'); }
  captureState() { return { counter: this.counter }; }
  restoreState(s) { this.counter = s.counter; }
}
`, 'utf-8');

    agent = new Agent({ llm: new OneToolCallLLM() as never });
    // withViewer 触发 agent 自注册（agentId 与日志路由一致，与真实 runtime 相同）
    await agent.withViewer('FeatureEventStreamAgent');
    agentId = (agent as any).agentId;
  });

  afterAll(async () => {
    debugHub.unregisterAgent(agentId);
    debugHub.stop();
    await worker.stop();
    if (originalUdsPath === undefined) {
      delete process.env.AGENTDEV_UDS_PATH;
    } else {
      process.env.AGENTDEV_UDS_PATH = originalUdsPath;
    }
  });

  function getSessionLogs(): DebugLogEntry[] {
    const session = (worker as any).agentSessions.get(agentId);
    return session?.logs ?? [];
  }

  function featureEvents(feature: string): DebugLogEntry[] {
    return filterDebuggerLogs(getSessionLogs(), { feature });
  }

  it('emits feature.mounted on mountFeature with tool count', async () => {
    await agent.mountFeature(new StreamFeature() as never);

    await waitFor(() => featureEvents('stream-fixture').some(e => (e.data as any)?.event === 'feature.mounted'));
    const mounted = featureEvents('stream-fixture').find(e => (e.data as any)?.event === 'feature.mounted')!;
    expect(mounted.context.feature).toBe('stream-fixture');
    expect(mounted.data).toMatchObject({ event: 'feature.mounted', toolCount: 1 });
    expect(mounted.namespace).toBe('agent.features');
  });

  it('emits hook.invoked with lifecycle/method/kind context during onCall', async () => {
    await agent.onCall('trigger hooks');

    await waitFor(() => featureEvents('stream-fixture').some(e => (e.data as any)?.event === 'hook.invoked'));
    const hookEvent = featureEvents('stream-fixture').find(e => (e.data as any)?.event === 'hook.invoked')!;
    expect(hookEvent.context.feature).toBe('stream-fixture');
    expect(hookEvent.context.lifecycle).toBe('CallStart');
    expect(hookEvent.context.hookMethod).toBe('onCallStart');
    expect(hookEvent.context.hookKind).toBe('observe');
  });

  it('emits tool.executed with toolName context and durationMs', async () => {
    const freshLLM = new OneToolCallLLM();
    (agent as any).llm = freshLLM;
    await agent.onCall('trigger tool');

    await waitFor(() => featureEvents('stream-fixture').some(e => (e.data as any)?.event === 'tool.executed'));
    const toolEvent = featureEvents('stream-fixture').find(e => (e.data as any)?.event === 'tool.executed')!;
    expect(toolEvent.context.feature).toBe('stream-fixture');
    expect(toolEvent.context.toolName).toBe('stream_tool');
    expect(typeof (toolEvent.data as any)?.durationMs).toBe('number');
  });

  it('emits feature.tool_state_changed on tool disable/enable', async () => {
    agent.disable('stream-fixture');
    await waitFor(() => featureEvents('stream-fixture').some(
      e => (e.data as any)?.event === 'feature.tool_state_changed' && (e.data as any)?.action === 'disabled'
    ));
    const disabled = featureEvents('stream-fixture').find(
      e => (e.data as any)?.event === 'feature.tool_state_changed' && (e.data as any)?.action === 'disabled'
    )!;
    expect(disabled.data).toMatchObject({ event: 'feature.tool_state_changed', action: 'disabled', toolCount: 1 });

    agent.enable('stream-fixture');
    await waitFor(() => featureEvents('stream-fixture').some(
      e => (e.data as any)?.event === 'feature.tool_state_changed' && (e.data as any)?.action === 'enabled'
    ));
  });

  it('emits hook_state_changed events on hook disable/enable', async () => {
    agent.disableHook('CallStart', 'stream-fixture', 'onCallStart');
    await waitFor(() => featureEvents('stream-fixture').some(
      e => (e.data as any)?.event === 'feature.hook_state_changed' && (e.data as any)?.action === 'disabled'
    ));
    const hookDisabled = featureEvents('stream-fixture').find(
      e => (e.data as any)?.event === 'feature.hook_state_changed' && (e.data as any)?.action === 'disabled'
    )!;
    expect(hookDisabled.context.feature).toBe('stream-fixture');
    expect(hookDisabled.context.lifecycle).toBe('CallStart');
    expect(hookDisabled.context.hookMethod).toBe('onCallStart');

    agent.enableHook('CallStart', 'stream-fixture', 'onCallStart');
    await waitFor(() => featureEvents('stream-fixture').some(
      e => (e.data as any)?.event === 'feature.hook_state_changed' && (e.data as any)?.action === 'enabled'
    ));
  });

  it('emits feature.reloaded with durationMs on successful reload', async () => {
    class ReloadV1 {
      name = 'event-reload-fixture';
      counter = 0;
      getTools() {
        return [{ name: 'evt_tool', description: 'v1', execute: async () => 'v1' }];
      }
      captureState() { return { counter: this.counter }; }
      restoreState(s: { counter: number }) { this.counter = s.counter; }
    }
    await agent.mountFeature(new ReloadV1() as never);

    await agent.reloadFeature('event-reload-fixture', pathToFileURL(join(fixtureDir, 'evt-v2.mjs')).href);

    await waitFor(() => featureEvents('event-reload-fixture').some(e => (e.data as any)?.event === 'feature.reloaded'));
    const reloaded = featureEvents('event-reload-fixture').find(e => (e.data as any)?.event === 'feature.reloaded')!;
    expect(reloaded.context.feature).toBe('event-reload-fixture');
    expect(typeof (reloaded.data as any)?.durationMs).toBe('number');
    expect((reloaded.data as any)?.stateTransferred).toBe(true);
  });

  it('emits feature.reload_reverted with reason when new module fails to init', async () => {
    // reload 失败回退后错误重新抛出（fail loud），事件在抛出前已发出
    await expect(
      agent.reloadFeature('event-reload-fixture', pathToFileURL(join(fixtureDir, 'evt-broken.mjs')).href)
    ).rejects.toThrow(/stage 'mount': broken on purpose/);

    await waitFor(() => featureEvents('event-reload-fixture').some(e => (e.data as any)?.event === 'feature.reload_reverted'));
    const reverted = featureEvents('event-reload-fixture').find(e => (e.data as any)?.event === 'feature.reload_reverted')!;
    expect(reverted.level).toBe('warn');
    expect((reverted.data as any)?.reason).toContain('mount');
    expect(typeof (reverted.data as any)?.durationMs).toBe('number');
  });

  it('emits feature.removed on removeFeature', async () => {
    agent.removeFeature('stream-fixture');

    await waitFor(() => featureEvents('stream-fixture').some(e => (e.data as any)?.event === 'feature.removed'));
    const removed = featureEvents('stream-fixture').find(e => (e.data as any)?.event === 'feature.removed')!;
    expect(removed.context.feature).toBe('stream-fixture');
    expect(removed.data).toMatchObject({ event: 'feature.removed' });
  });

  it('round-trips: feature filter returns a coherent time-ordered stream with stable field names', async () => {
    // feature 过滤返回该 feature 的全部日志；事件是其中带 data.event 标记的子序列
    const events = featureEvents('stream-fixture').filter(e => (e.data as any)?.event !== undefined);
    expect(events.length).toBeGreaterThanOrEqual(4);

    // 时间序单调
    for (let i = 1; i < events.length; i++) {
      expect(events[i].timestamp).toBeGreaterThanOrEqual(events[i - 1].timestamp);
    }
    // 每条都有合法 event 类型 + context.feature
    for (const e of events) {
      expect(EVENT_TYPES).toContain((e.data as any)?.event);
      expect(e.context.feature).toBe('stream-fixture');
    }
    // 关键事件序列存在（mounted 在最前，removed 在最后）
    expect((events[0].data as any).event).toBe('feature.mounted');
    expect((events[events.length - 1].data as any).event).toBe('feature.removed');
  });
});
