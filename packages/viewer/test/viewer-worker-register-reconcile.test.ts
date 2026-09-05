import { describe, it, expect } from 'vitest';
import { ViewerWorker } from '../src/viewer-worker.js';

/**
 * 注册对账测试：agent 进程被关闭时 call.finish / tool.complete 无法送达，
 * ViewerWorker session 会残留上一个进程的 call 运行状态（callActive /
 * activeToolNames / currentState），前端状态条因此永久停留在
 * "正在执行工具 · ask_user_choice"。handleRegisterAgent 必须在重新注册时
 * 作废这些遗留状态：
 *
 * 1. 新进程接管（不带 activeInputRequest）→ 旧 call 状态一律作废
 * 2. 同进程重连（带 activeInputRequest，call 真实存活等待输入）→ 运行状态保留
 */

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-register-reconcile-${process.pid}-${Date.now()}`;
  }
  return `/tmp/agentdev-register-reconcile-${process.pid}-${Date.now()}.sock`;
}

function createMockRes() {
  let statusCode = 0;
  let body = '';
  return {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { body = data; },
    getStatusCode() { return statusCode; },
    getJson() { return JSON.parse(body); },
  };
}

/** 模拟一次等待用户选择中的 call：call.start + tool.start（ask_user_choice） */
function seedStuckCallState(worker: ViewerWorker, agentId: string): void {
  worker.handlePushNotification({
    agentId,
    notification: { type: 'call.start', category: 'state', timestamp: 1000, data: {} },
  });
  worker.handlePushNotification({
    agentId,
    notification: {
      type: 'tool.start', category: 'state', timestamp: 2000,
      data: { toolName: 'ask_user_choice', callId: 'call-1' },
    },
  });
}

describe('ViewerWorker register-time call state reconciliation', () => {
  it('新进程接管（无活跃输入租约）时应作废旧进程遗留的 call 运行状态', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'reconcile-reset-agent';
    worker.getOrCreateSession(agentId, 'Reconcile Reset Test');

    seedStuckCallState(worker, agentId);

    // 死亡前的快照确实处于"正在执行工具"态（前置条件自检）
    let res = createMockRes();
    (worker as any).handleGetAgentNotification({} as any, res as any, agentId);
    expect(res.getJson().runtime.callActive).toBe(true);
    expect(res.getJson().runtime.activeToolNames).toEqual(['ask_user_choice']);

    // 进程重启后重新注册：注册快照是完整事实来源，遗留 call 状态作废
    worker.handleRegisterAgent({ agentId, name: 'Reconcile Reset Test' });

    res = createMockRes();
    (worker as any).handleGetAgentNotification({} as any, res as any, agentId);
    const runtime = res.getJson().runtime;
    expect(runtime.callActive).toBe(false);
    expect(runtime.stage).toBe('idle');
    expect(runtime.activeToolNames).toEqual([]);
    expect(runtime.activeToolCount).toBe(0);
    expect(res.getJson().state).toBeNull();
  });

  it('同进程重连（携带活跃输入租约）时应保留运行状态', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'reconcile-keep-agent';
    worker.getOrCreateSession(agentId, 'Reconcile Keep Test');

    seedStuckCallState(worker, agentId);

    // UDS 重连路径 reregisterAllAgents 会携带仍有本地 resolver 的输入租约，
    // 说明 call 真实存活（等待用户输入中），运行状态不得作废。
    worker.handleRegisterAgent({
      agentId,
      name: 'Reconcile Keep Test',
      activeInputRequest: {
        requestId: 'req-1',
        prompt: '选择一个选项',
        mode: 'choices',
        questions: [{ id: 'q1', question: 'How?', options: [{ id: 'a' }, { id: 'b' }] }],
        timestamp: 2500,
      },
    });

    const res = createMockRes();
    (worker as any).handleGetAgentNotification({} as any, res as any, agentId);
    const runtime = res.getJson().runtime;
    expect(runtime.callActive).toBe(true);
    expect(runtime.stage).toBe('tool_executing');
    expect(runtime.activeToolNames).toEqual(['ask_user_choice']);
  });

  it('作废遗留状态后，新 call 的 tool 生命周期应正常推进', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'reconcile-next-call-agent';
    worker.getOrCreateSession(agentId, 'Reconcile Next Call Test');

    seedStuckCallState(worker, agentId);
    worker.handleRegisterAgent({ agentId, name: 'Reconcile Next Call Test' });

    // 用户发起下一轮对话：新 call 正常推进，不再被旧状态污染
    worker.handlePushNotification({
      agentId,
      notification: { type: 'call.start', category: 'state', timestamp: 5000, data: {} },
    });
    worker.handlePushNotification({
      agentId,
      notification: {
        type: 'tool.start', category: 'state', timestamp: 6000,
        data: { toolName: 'read_file', callId: 'call-2' },
      },
    });

    const res = createMockRes();
    (worker as any).handleGetAgentNotification({} as any, res as any, agentId);
    const runtime = res.getJson().runtime;
    expect(runtime.callActive).toBe(true);
    expect(runtime.activeToolNames).toEqual(['read_file']);
  });
});
