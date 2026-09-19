import { describe, it, expect } from 'vitest';
import { ViewerWorker, type ViewerSessionEvent } from '../src/viewer-worker.js';

/**
 * 会话事件总线测试：每个改变前端可见状态的内存写入点都必须 emit
 * （事件源完整性约束），包括非 IPC 写入路径——lease 提交、排队转交、
 * 注册对账。漏挂即前端状态滞留（SSE 改造的 S1/S2 回归面）。
 *
 * 快照方法与 GET 端点同构性：事件路径与轮询路径永远读同一组装单点。
 */

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-session-events-${process.pid}-${Date.now()}`;
  }
  return `/tmp/agentdev-session-events-${process.pid}-${Date.now()}.sock`;
}

function createWorker(): ViewerWorker {
  return new ViewerWorker(0, false, getTestUdsPath());
}

class EventRecorder {
  events: ViewerSessionEvent[] = [];
  private unsubscribe: (() => void) | null = null;

  attach(worker: ViewerWorker): void {
    this.unsubscribe = worker.onSessionEvent((e) => { this.events.push(e); });
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  ofKind(kind: ViewerSessionEvent['kind']): ViewerSessionEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }
}

/** forwardInputResponse 成功所需的最小 socket 桩：注册 clientId 并挂进 udsClients */
function stubConnectedClient(worker: ViewerWorker, agentId: string, clientId: string): void {
  const session = worker.getOrCreateSession(agentId, 'Test Agent');
  session.clientId = clientId;
  (worker as any).udsClients.set(clientId, {
    write: () => true,
    destroy: () => {},
  });
}

/** 模拟一次携带 JSON body 的 POST 请求（data → end 顺序送达） */
function createMockJsonReq(body: unknown) {
  const raw = JSON.stringify(body);
  const handlers: Record<string, Array<(d?: string) => void>> = {};
  return {
    setEncoding: () => {},
    resume: () => {},
    on: (event: string, cb: (d?: string) => void) => {
      (handlers[event] ||= []).push(cb);
      if (event === 'data') {
        // handler 注册后异步送达 body，再触发 end，复刻真实流的顺序
        queueMicrotask(() => {
          for (const h of handlers.data) h(raw);
          for (const h of handlers.end || []) h();
        });
      }
    },
  } as any;
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

describe('ViewerWorker session event bus', () => {
  it('订阅后收到事件，退订后不再收到，重复退订安全', () => {
    const worker = createWorker();
    const recorder = new EventRecorder();
    recorder.attach(worker);

    worker.getOrCreateSession('agent-a', 'A');
    worker.handleUpdateTodoPlan({ agentId: 'agent-a', plan: { tasks: [], summary: { total: 0, pending: 0, inProgress: 0, completed: 0, cancelled: 0 } } as any });
    expect(recorder.ofKind('todo')).toHaveLength(1);

    recorder.detach();
    recorder.detach();
    worker.handleUpdateTodoPlan({ agentId: 'agent-a', plan: { tasks: [], summary: { total: 0, pending: 0, inProgress: 0, completed: 0, cancelled: 0 } } as any });
    expect(recorder.ofKind('todo')).toHaveLength(1);
  });

  it('监听器抛异常不阻断 worker 与其他监听器', () => {
    const worker = createWorker();
    worker.getOrCreateSession('agent-a', 'A');

    const bad: ViewerSessionEvent[] = [];
    const good: ViewerSessionEvent[] = [];
    worker.onSessionEvent(() => { throw new Error('listener boom'); });
    worker.onSessionEvent((e) => { good.push(e); });

    expect(() => {
      worker.handleUpdateAgentOverview({ agentId: 'agent-a', overview: { updatedAt: 1 } as any });
    }).not.toThrow();
    expect(good.filter((e) => e.kind === 'overview')).toHaveLength(1);
    expect(bad).toHaveLength(0);
  });

  it('hasSessionEventListeners 反映订阅状态（宿主启动探测）', () => {
    const worker = createWorker();
    expect(worker.hasSessionEventListeners()).toBe(false);
    const off = worker.onSessionEvent(() => {});
    expect(worker.hasSessionEventListeners()).toBe(true);
    off();
    expect(worker.hasSessionEventListeners()).toBe(false);
  });
});

describe('notification 事件', () => {
  it('state/event 类通知写入后 emit；log.entry 不 emit（不改快照状态）', () => {
    const worker = createWorker();
    const recorder = new EventRecorder();
    recorder.attach(worker);
    worker.getOrCreateSession('agent-n', 'N');

    worker.handlePushNotification({ agentId: 'agent-n', notification: { type: 'call.start', category: 'state', timestamp: 1, data: {} } });
    worker.handlePushNotification({ agentId: 'agent-n', notification: { type: 'llm.chunk', category: 'event', timestamp: 2, data: {} } });
    worker.handlePushNotification({ agentId: 'agent-n', notification: { type: 'log.entry', category: 'event', timestamp: 3, data: { level: 'info', message: 'x' } } });

    const notes = recorder.ofKind('notification');
    expect(notes).toHaveLength(2);
    expect(notes.every((e) => e.agentId === 'agent-n')).toBe(true);
  });

  it('未知 agent 的推送不 emit', () => {
    const worker = createWorker();
    const recorder = new EventRecorder();
    recorder.attach(worker);
    worker.handlePushNotification({ agentId: 'ghost', notification: { type: 'call.start', category: 'state', timestamp: 1, data: {} } });
    expect(recorder.events).toHaveLength(0);
  });
});

describe('overview / todo / messages 事件', () => {
  it('overview 与 todo 写入后 emit', () => {
    const worker = createWorker();
    const recorder = new EventRecorder();
    recorder.attach(worker);
    worker.getOrCreateSession('agent-ot', 'OT');

    worker.handleUpdateAgentOverview({ agentId: 'agent-ot', overview: { updatedAt: 1 } as any });
    worker.handleUpdateTodoPlan({ agentId: 'agent-ot', plan: { tasks: [], summary: { total: 0, pending: 0, inProgress: 0, completed: 0, cancelled: 0 } } as any });

    expect(recorder.ofKind('overview')).toHaveLength(1);
    expect(recorder.ofKind('todo')).toHaveLength(1);
  });

  it('messages 真实变更 emit 带 probe；no-op 推送不 emit', () => {
    const worker = createWorker();
    const recorder = new EventRecorder();
    recorder.attach(worker);
    worker.getOrCreateSession('agent-m', 'M');

    const msg = { role: 'user', content: 'hello' };
    worker.handlePushMessages({ agentId: 'agent-m', messages: [msg], mode: 'full', generation: 0 });
    let events = recorder.ofKind('messages') as Extract<ViewerSessionEvent, { kind: 'messages' }>[];
    expect(events).toHaveLength(1);
    expect(events[0].probe.seq).toBe(1);
    expect(events[0].probe.count).toBe(1);
    expect(events[0].probe.changeKind).toBe('append');
    expect(events[0].probe.fakeFullBytes).toBeGreaterThan(0);

    // no-op full 推送（内容不变）：内存未变，不得 emit
    worker.handlePushMessages({ agentId: 'agent-m', messages: [msg], mode: 'full', generation: 0 });
    events = recorder.ofKind('messages') as Extract<ViewerSessionEvent, { kind: 'messages' }>[];
    expect(events).toHaveLength(1);
  });
});

describe('input-requests 事件（inputLease 5 个写入点）', () => {
  it('request-input 设置 lease 与 cancelled 清除都 emit', () => {
    const worker = createWorker();
    const recorder = new EventRecorder();
    recorder.attach(worker);
    worker.getOrCreateSession('agent-i', 'I');

    worker.handleRequestInput({ agentId: 'agent-i', requestId: 'req-1', prompt: '请输入', mode: 'text' });
    expect(recorder.ofKind('input-requests')).toHaveLength(1);
    expect(worker.getInputRequestsSnapshot('agent-i')).toHaveLength(1);

    worker.handleInputRequestCancelled({ agentId: 'agent-i', requestId: 'req-1' });
    expect(recorder.ofKind('input-requests')).toHaveLength(2);
    expect(worker.getInputRequestsSnapshot('agent-i')).toHaveLength(0);
  });

  it('handlePostInput 提交（非 IPC 路径）清除 lease 并 emit', async () => {
    const worker = createWorker();
    const recorder = new EventRecorder();
    recorder.attach(worker);
    stubConnectedClient(worker, 'agent-p', 'client-p');

    worker.handleRequestInput({ agentId: 'agent-p', requestId: 'req-2', prompt: '请输入', mode: 'text' });
    recorder.events.length = 0;

    const req = createMockJsonReq({ requestId: 'req-2', input: '答案' });
    const res = createMockRes();
    (worker as any).handlePostInput(req, res, 'agent-p');
    // body 经 microtask 送达，等一轮再断言
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.getStatusCode()).toBe(200);
    expect(recorder.ofKind('input-requests')).toHaveLength(1);
    expect(worker.getInputRequestsSnapshot('agent-p')).toHaveLength(0);
  });

  it('submitUserTurn lease 直投（非 IPC 路径）清除 lease 并 emit', () => {
    const worker = createWorker();
    const recorder = new EventRecorder();
    recorder.attach(worker);
    stubConnectedClient(worker, 'agent-s', 'client-s');

    worker.handleRequestInput({ agentId: 'agent-s', requestId: 'req-3', prompt: '请输入', mode: 'text' });
    recorder.events.length = 0;

    const result = worker.submitUserTurn('agent-s', { text: 'answer' } as any);
    expect(result.success).toBe(true);
    expect(recorder.ofKind('input-requests')).toHaveLength(1);
    expect(worker.getInputRequestsSnapshot('agent-s')).toHaveLength(0);
  });

  it('handleRegisterAgent 租约对账（恢复与删除）不额外 emit input-requests，由 connection 事件驱动对账', () => {
    const worker = createWorker();
    const recorder = new EventRecorder();
    recorder.attach(worker);
    stubConnectedClient(worker, 'agent-r', 'client-r');

    worker.handleRequestInput({ agentId: 'agent-r', requestId: 'req-4', prompt: '选择', mode: 'choices', questions: [{ id: 'q', question: '?', options: [{ id: 'a' }] }] });
    recorder.events.length = 0;

    // 重连对账：无活跃租约 → 旧 lease 删除（内存变更但无独立事件，重连事件兜底）
    worker.handleRegisterAgent({ agentId: 'agent-r', name: 'R' });
    const connections = recorder.ofKind('connection') as Extract<ViewerSessionEvent, { kind: 'connection' }>[];
    expect(connections).toHaveLength(1);
    expect(connections[0].reconnected).toBe(true);
    expect(recorder.ofKind('input-requests')).toHaveLength(0);
    expect(worker.getInputRequestsSnapshot('agent-r')).toHaveLength(0);
  });
});

describe('queued-inputs 事件（写入与消费的完整路径）', () => {
  it('submitUserTurn 排队入队 emit；handleDequeueInput 出队 emit', () => {
    const worker = createWorker();
    const recorder = new EventRecorder();
    recorder.attach(worker);
    stubConnectedClient(worker, 'agent-q', 'client-q');

    const queued = worker.submitUserTurn('agent-q', { text: '第一句' } as any);
    expect(queued.success).toBe(true);
    expect(recorder.ofKind('queued-inputs')).toHaveLength(1);
    expect(worker.getQueuedInputsSnapshot('agent-q')).toHaveLength(1);

    const req = { resume: () => {} } as any;
    const res = createMockRes();
    (worker as any).handleDequeueInput(req, res, 'agent-q');
    expect(res.getStatusCode()).toBe(200);
    expect(recorder.ofKind('queued-inputs')).toHaveLength(2);
    expect(worker.getQueuedInputsSnapshot('agent-q')).toHaveLength(0);
  });

  it('handleRequestInput 队列转交（不经过 dequeue 端点的第三条路径）emit', () => {
    const worker = createWorker();
    const recorder = new EventRecorder();
    recorder.attach(worker);
    stubConnectedClient(worker, 'agent-t', 'client-t');

    worker.submitUserTurn('agent-t', { text: '排队中' } as any);
    recorder.events.length = 0;

    // 新输入请求到达：队首直接转交（mode 非 choices 且队列非空）
    worker.handleRequestInput({ agentId: 'agent-t', requestId: 'req-5', prompt: '输入', mode: 'text' });

    const queuedEvents = recorder.ofKind('queued-inputs');
    expect(queuedEvents).toHaveLength(1);
    expect(worker.getQueuedInputsSnapshot('agent-t')).toHaveLength(0);
  });
});

describe('connection 事件', () => {
  it('首次注册 reconnected=false；重连注册 reconnected=true；注销 connected=false', () => {
    const worker = createWorker();
    const recorder = new EventRecorder();
    recorder.attach(worker);

    worker.handleRegisterAgent({ agentId: 'agent-c', name: 'C' }, 'client-1');
    worker.handleRegisterAgent({ agentId: 'agent-c', name: 'C' }, 'client-1');
    worker.handleUnregisterAgent({ agentId: 'agent-c' });

    const connections = recorder.ofKind('connection') as Extract<ViewerSessionEvent, { kind: 'connection' }>[];
    expect(connections).toHaveLength(3);
    expect(connections[0]).toMatchObject({ connected: true, reconnected: false });
    expect(connections[1]).toMatchObject({ connected: true, reconnected: true });
    expect(connections[2]).toMatchObject({ connected: false, reconnected: false });
  });

  it('handleDeleteAgent（第三个 agentSessions 删除点）emit connected=false', () => {
    const worker = createWorker();
    const recorder = new EventRecorder();
    recorder.attach(worker);
    worker.getOrCreateSession('agent-d', 'D');

    const res = createMockRes();
    (worker as any).handleDeleteAgent({} as any, res, 'agent-d');

    expect(res.getStatusCode()).toBe(200);
    expect(recorder.ofKind('connection')).toHaveLength(1);
  });

  it('UDS 断连按 clientId 反查全部受影响 agent（一个连接可承载多 session）', () => {
    const worker = createWorker();
    const recorder = new EventRecorder();
    recorder.attach(worker);

    stubConnectedClient(worker, 'agent-x', 'shared-client');
    const sessionY = worker.getOrCreateSession('agent-y', 'Y');
    sessionY.clientId = 'shared-client';
    stubConnectedClient(worker, 'agent-z', 'other-client');

    (worker as any).emitDisconnectedByClientId('shared-client');

    const connections = recorder.ofKind('connection') as Extract<ViewerSessionEvent, { kind: 'connection' }>[];
    expect(connections).toHaveLength(2);
    const ids = connections.map((e) => e.agentId).sort();
    expect(ids).toEqual(['agent-x', 'agent-y']);
    expect(connections.every((e) => e.connected === false)).toBe(true);
  });
});

describe('快照方法与 GET 端点同构', () => {
  it('getNotificationSnapshot 与 GET /notification 响应逐字段一致（除 hasNewEvents）', () => {
    const worker = createWorker();
    worker.getOrCreateSession('agent-snap', 'Snap');
    worker.handlePushNotification({ agentId: 'agent-snap', notification: { type: 'call.start', category: 'state', timestamp: 1, data: {} } });

    const snapshot = worker.getNotificationSnapshot('agent-snap')!;
    expect(snapshot.callActive).toBe(true);
    expect(snapshot.state).toMatchObject({ type: 'call.start' });

    const res = createMockRes();
    (worker as any).handleGetAgentNotification({} as any, res, 'agent-snap');
    const viaGet = res.getJson();
    expect(viaGet.state).toEqual(snapshot.state);
    expect(viaGet.event).toEqual(snapshot.event);
    expect(viaGet.runtime).toEqual(snapshot.runtime);
    expect(viaGet.callActive).toEqual(snapshot.callActive);
  });

  it('getOverviewSnapshot 含 _messagesProbe（与 GET /overview 同构）；不存在的 agent 返回 null', () => {
    const worker = createWorker();
    worker.getOrCreateSession('agent-snap2', 'Snap2');
    worker.handlePushMessages({ agentId: 'agent-snap2', messages: [{ role: 'user', content: 'x' }], mode: 'full', generation: 0 });

    const snapshot = worker.getOverviewSnapshot('agent-snap2')!;
    expect(snapshot._messagesProbe).toMatchObject({ seq: 1, count: 1 });

    const res = createMockRes();
    (worker as any).handleGetAgentOverview({} as any, res, 'agent-snap2');
    expect(res.getJson()).toEqual(snapshot);

    expect(worker.getOverviewSnapshot('ghost')).toBeNull();
    expect(worker.isAgentConnected('ghost')).toBeNull();
  });
});

describe('无订阅者时的结构性零开销', () => {
  it('全部写入路径在无订阅者时正常执行且不抛错', () => {
    const worker = createWorker();
    stubConnectedClient(worker, 'agent-solo', 'client-solo');

    expect(() => {
      worker.handlePushNotification({ agentId: 'agent-solo', notification: { type: 'call.start', category: 'state', timestamp: 1, data: {} } });
      worker.handleUpdateAgentOverview({ agentId: 'agent-solo', overview: { updatedAt: 1 } as any });
      worker.handleUpdateTodoPlan({ agentId: 'agent-solo', plan: {} as any });
      worker.handlePushMessages({ agentId: 'agent-solo', messages: [{ role: 'user', content: 'x' }], mode: 'full', generation: 0 });
      worker.handleRequestInput({ agentId: 'agent-solo', requestId: 'r', prompt: 'p', mode: 'text' });
      worker.submitUserTurn('agent-solo', { text: 'q' } as any);
      worker.handleRegisterAgent({ agentId: 'agent-solo', name: 'Solo' });
      worker.handleUnregisterAgent({ agentId: 'agent-solo' });
    }).not.toThrow();
  });
});

describe('listAgentStates（宿主 hello 首连快照的清单源）', () => {
  it('返回 id/name/connected 轻量清单，connected 随连接在册状态变化', () => {
    const worker = createWorker();

    stubConnectedClient(worker, 'agent-on', 'client-1');
    worker.getOrCreateSession('agent-off', 'Off'); // 存在但未连接

    expect(worker.listAgentStates()).toEqual([
      { id: 'agent-on', name: 'Test Agent', connected: true },
      { id: 'agent-off', name: 'Off', connected: false },
    ]);

    (worker as any).udsClients.delete('client-1');
    expect(worker.listAgentStates().find((s) => s.id === 'agent-on')?.connected).toBe(false);
  });
});
