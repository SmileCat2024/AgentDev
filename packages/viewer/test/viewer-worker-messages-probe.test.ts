import { describe, it, expect } from 'vitest';
import { ViewerWorker } from '../src/viewer-worker.js';

/**
 * Ticket 07 / ADR-0012：ViewerWorker 增量取数能力。
 *
 * 覆盖四块：
 * 1. changeKind 三分类（append / tail / rewrite）+ 未变化为 null
 * 2. rewrite 盲区修正：中段变化但 count 与末条签名均不变时，
 *    session.messages 必须照常更新（旧实现 hasMessagesChanged 会静默丢弃）
 * 3. /messages 的 ?since / ?tail 切片；无参数响应与改造前逐字节一致
 * 4. /overview 响应携带 _messagesProbe（HTTP 组装层产物），未走过推送
 *    路径时缺省
 */

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-messages-probe-${process.pid}-${Date.now()}`;
  }
  return `/tmp/agentdev-messages-probe-${process.pid}-${Date.now()}.sock`;
}

/** 模拟 HTTP response，捕获 writeHead 状态码与 end 返回体 */
function createMockRes() {
  let statusCode = 0;
  let body = '';
  return {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { body = data; },
    getStatusCode() { return statusCode; },
    getBody() { return body; },
    getJson() { return JSON.parse(body); },
  };
}

function makeMsg(role: string, content: string, extra?: Record<string, any>) {
  return { role, content, ...extra };
}

function bytesOf(messages: any[]): number {
  return messages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
}

function createWorker(): { worker: any; agentId: string } {
  const worker: any = new ViewerWorker(0, false, getTestUdsPath());
  const agentId = 'probe-test-agent';
  worker.getOrCreateSession(agentId, 'Messages Probe Test');
  return { worker, agentId };
}

function push(worker: any, agentId: string, messages: any[]): void {
  worker.handlePushMessages({ agentId, messages });
}

/** 读 overview 响应（含 _messagesProbe 组装） */
function readOverview(worker: any, agentId: string): any {
  const res = createMockRes();
  worker.handleGetAgentOverview({} as any, res as any, agentId);
  return res.getJson();
}

/** 读 messages 响应（search 为查询串，如 'since=1' / 'tail=1' / ''） */
function readMessages(worker: any, agentId: string, search = '') {
  const res = createMockRes();
  worker.handleGetAgentMessages(
    {} as any,
    res as any,
    agentId,
    new URLSearchParams(search),
  );
  return { status: res.getStatusCode(), body: res.getBody(), json: res.getJson() };
}

describe('changeKind classification (push-time)', () => {
  it('classifies pure tail addition as append with sinceIndex = old length', () => {
    const { worker, agentId } = createWorker();
    const m1 = makeMsg('user', 'hello');
    const m2 = makeMsg('assistant', 'hi there');

    push(worker, agentId, [m1]);
    push(worker, agentId, [m1, m2]);

    const probe = readOverview(worker, agentId)._messagesProbe;
    expect(probe.changeKind).toBe('append');
    expect(probe.sinceIndex).toBe(1);
    expect(probe.count).toBe(2);
  });

  it('classifies first push on empty session as append with sinceIndex = 0', () => {
    const { worker, agentId } = createWorker();
    const m1 = makeMsg('user', 'first');

    push(worker, agentId, [m1]);

    const probe = readOverview(worker, agentId)._messagesProbe;
    expect(probe.changeKind).toBe('append');
    expect(probe.sinceIndex).toBe(0);
  });

  it('classifies last-message rewrite (same count) as tail', () => {
    const { worker, agentId } = createWorker();
    const m1 = makeMsg('user', 'hello');
    const m2 = makeMsg('assistant', 'hi');

    push(worker, agentId, [m1, m2]);
    // 流式输出：前缀引用不变，末条被改写
    const m2Streamed = makeMsg('assistant', 'hi there, streaming...');
    push(worker, agentId, [m1, m2Streamed]);

    const probe = readOverview(worker, agentId)._messagesProbe;
    expect(probe.changeKind).toBe('tail');
    expect(probe.sinceIndex).toBe(1);
    expect(probe.count).toBe(2);
  });

  it('still classifies tail when unchanged prefix items were rebuilt (deep equal)', () => {
    const { worker, agentId } = createWorker();
    push(worker, agentId, [makeMsg('user', 'hello'), makeMsg('assistant', 'hi')]);

    // 前缀对象被重建（引用不同但 JSON 全等），末条改写
    push(worker, agentId, [
      makeMsg('user', 'hello'),
      makeMsg('assistant', 'hi there'),
    ]);

    const probe = readOverview(worker, agentId)._messagesProbe;
    expect(probe.changeKind).toBe('tail');
  });

  it('classifies count decrease as rewrite', () => {
    const { worker, agentId } = createWorker();
    const m1 = makeMsg('user', 'a');
    const m2 = makeMsg('assistant', 'b');
    const m3 = makeMsg('user', 'c');

    push(worker, agentId, [m1, m2, m3]);
    // rollback / compact：条数减少
    push(worker, agentId, [makeMsg('user', 'a2')]);

    const probe = readOverview(worker, agentId)._messagesProbe;
    expect(probe.changeKind).toBe('rewrite');
    expect(probe.sinceIndex).toBe(0);
    expect(probe.count).toBe(1);
  });

  it('classifies append-with-changed-prefix (not a real prefix) as rewrite', () => {
    const { worker, agentId } = createWorker();
    push(worker, agentId, [makeMsg('user', 'a'), makeMsg('assistant', 'b')]);

    // 变长但旧前缀被替换：不属于 append
    push(worker, agentId, [
      makeMsg('user', 'CHANGED'),
      makeMsg('assistant', 'b'),
      makeMsg('user', 'c'),
    ]);

    const probe = readOverview(worker, agentId)._messagesProbe;
    expect(probe.changeKind).toBe('rewrite');
  });

  it('reports changeKind null when pushed messages are unchanged (same refs)', () => {
    const { worker, agentId } = createWorker();
    const m1 = makeMsg('user', 'hello');
    const m2 = makeMsg('assistant', 'hi');

    push(worker, agentId, [m1, m2]);
    // 同一组引用重复推送：未变化
    push(worker, agentId, [m1, m2]);

    const probe = readOverview(worker, agentId)._messagesProbe;
    expect(probe.changeKind).toBeNull();
    expect(probe.count).toBe(2);
  });

  it('reports changeKind null when pushed messages are deep-equal but rebuilt', () => {
    const { worker, agentId } = createWorker();
    push(worker, agentId, [makeMsg('user', 'hello'), makeMsg('assistant', 'hi')]);

    // 全部重建但内容全等：未变化
    push(worker, agentId, [makeMsg('user', 'hello'), makeMsg('assistant', 'hi')]);

    const probe = readOverview(worker, agentId)._messagesProbe;
    expect(probe.changeKind).toBeNull();
  });
});

describe('rewrite blind spot fix', () => {
  it('updates session.messages when middle changes but count and last signature stay identical', () => {
    const { worker, agentId } = createWorker();
    const a = makeMsg('user', 'question');
    const b = makeMsg('assistant', 'original middle');
    const c = makeMsg('user', 'follow up');

    push(worker, agentId, [a, b, c]);

    // 中段替换：count 不变、末条引用与签名均不变——旧实现
    // hasMessagesChanged（只比 count + 末条签名）会静默丢弃这次推送
    const bReplaced = makeMsg('assistant', 'REPLACED middle');
    const rewritten = [a, bReplaced, c];
    push(worker, agentId, rewritten);

    const session = worker.agentSessions.get(agentId);
    expect(session.messages).toHaveLength(3);
    expect(session.messages[1].content).toBe('REPLACED middle');
    expect(session.messages).toEqual(rewritten);

    const probe = readOverview(worker, agentId)._messagesProbe;
    expect(probe.changeKind).toBe('rewrite');
  });

  it('classifies middle replacement plus last-message change as rewrite', () => {
    const { worker, agentId } = createWorker();
    push(worker, agentId, [
      makeMsg('user', 'q'),
      makeMsg('assistant', 'mid'),
      makeMsg('user', 'last'),
    ]);

    // 中段变化且末条也变了：不是 tail（tail 要求除末条外全等）
    push(worker, agentId, [
      makeMsg('user', 'q'),
      makeMsg('assistant', 'mid CHANGED'),
      makeMsg('user', 'last EDITED'),
    ]);

    const probe = readOverview(worker, agentId)._messagesProbe;
    expect(probe.changeKind).toBe('rewrite');
  });
});

describe('/messages incremental params', () => {
  function setupThreeMessages(): { worker: any; agentId: string; msgs: any[] } {
    const { worker, agentId } = createWorker();
    const msgs = [
      makeMsg('user', 'm1'),
      makeMsg('assistant', 'm2'),
      makeMsg('user', 'm3'),
    ];
    push(worker, agentId, msgs);
    return { worker, agentId, msgs };
  }

  it('keeps the no-param response byte-identical to the legacy full shape', () => {
    const { worker, agentId, msgs } = setupThreeMessages();

    const r = readMessages(worker, agentId);

    expect(r.status).toBe(200);
    // 逐字节一致：{ agentId, messages } 全量数组，无任何附加字段
    expect(r.body).toBe(JSON.stringify({ agentId, messages: msgs }));
    expect(Object.keys(r.json)).toEqual(['agentId', 'messages']);
    expect(r.json.messages).toEqual(msgs);
  });

  it('keeps the no-param response byte-identical when searchParams is omitted', () => {
    const { worker, agentId, msgs } = setupThreeMessages();

    const res = createMockRes();
    worker.handleGetAgentMessages({} as any, res as any, agentId);

    expect(res.getBody()).toBe(JSON.stringify({ agentId, messages: msgs }));
  });

  it('serves ?since=<n> as tail slice with baseCount', () => {
    const { worker, agentId, msgs } = setupThreeMessages();

    const r = readMessages(worker, agentId, 'since=1');

    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(['messages', 'baseCount']);
    expect(r.json.baseCount).toBe(1);
    expect(r.json.messages).toEqual(msgs.slice(1));
  });

  it('serves ?since=0 as the full slice', () => {
    const { worker, agentId, msgs } = setupThreeMessages();

    const r = readMessages(worker, agentId, 'since=0');

    expect(r.status).toBe(200);
    expect(r.json.baseCount).toBe(0);
    expect(r.json.messages).toEqual(msgs);
  });

  it('returns an empty array when since exceeds message count', () => {
    const { worker, agentId } = setupThreeMessages();

    const r = readMessages(worker, agentId, 'since=99');

    expect(r.status).toBe(200);
    expect(r.json.baseCount).toBe(99);
    expect(r.json.messages).toEqual([]);
  });

  it('serves ?tail=1 as the last message only', () => {
    const { worker, agentId, msgs } = setupThreeMessages();

    const r = readMessages(worker, agentId, 'tail=1');

    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(['messages']);
    expect(r.json.messages).toEqual([msgs[2]]);
  });

  it('serves ?tail=1 as an empty array on an empty session', () => {
    const { worker, agentId } = createWorker();

    const r = readMessages(worker, agentId, 'tail=1');

    expect(r.status).toBe(200);
    expect(r.json).toEqual({ messages: [] });
  });

  it('rejects a malformed or negative since with 400', () => {
    const { worker, agentId } = setupThreeMessages();

    expect(readMessages(worker, agentId, 'since=abc').status).toBe(400);
    expect(readMessages(worker, agentId, 'since=-1').status).toBe(400);
  });

  it('routes query strings through handleAPI without breaking the path regex', () => {
    const { worker, agentId, msgs } = setupThreeMessages();

    const res = createMockRes();
    worker.handleAPI({
      url: `/api/agents/${agentId}/messages?since=1`,
      method: 'GET',
    } as any, res as any);

    expect(res.getStatusCode()).toBe(200);
    const json = res.getJson();
    expect(json.baseCount).toBe(1);
    expect(json.messages).toEqual(msgs.slice(1));
  });
});

describe('_messagesProbe on overview response', () => {
  it('omits the probe field before any message push', () => {
    const { worker, agentId } = createWorker();

    const overview = readOverview(worker, agentId);

    expect('_messagesProbe' in overview).toBe(false);
  });

  it('attaches a correctly typed probe after a push', () => {
    const { worker, agentId } = createWorker();
    const msgs = [makeMsg('user', 'hello'), makeMsg('assistant', 'hi')];
    push(worker, agentId, msgs);

    const overview = readOverview(worker, agentId);
    const probe = overview._messagesProbe;

    expect(probe).toBeDefined();
    expect(probe.count).toBe(2);
    expect(probe.changeKind).toBe('append');
    expect(probe.sinceIndex).toBe(0);
    // fakeFullBytes = 全量响应体假想字节数
    expect(probe.fakeFullBytes).toBe(bytesOf(msgs));
    // 类型健全性
    expect(typeof probe.count).toBe('number');
    expect(typeof probe.sinceIndex).toBe('number');
    expect(typeof probe.fakeFullBytes).toBe('number');
    // overview 原有字段不受污染
    expect(overview).toHaveProperty('context');
    expect(overview).toHaveProperty('usageStats');
    expect(overview).toHaveProperty('runtime');
  });

  it('updates the probe to changeKind null after an unchanged push', () => {
    const { worker, agentId } = createWorker();
    const msgs = [makeMsg('user', 'hello')];
    push(worker, agentId, msgs);

    push(worker, agentId, [makeMsg('user', 'hello')]);

    const probe = readOverview(worker, agentId)._messagesProbe;
    expect(probe.changeKind).toBeNull();
    expect(probe.fakeFullBytes).toBe(bytesOf(msgs));
  });

  it('reflects trimmed messages in count and fakeFullBytes after limits kick in', () => {
    const { worker, agentId } = createWorker();
    worker.MAX_MESSAGES = 2;

    push(worker, agentId, [
      makeMsg('user', 'm1'),
      makeMsg('assistant', 'm2'),
      makeMsg('user', 'm3'),
    ]);

    const session = worker.agentSessions.get(agentId);
    expect(session.messages).toHaveLength(2);

    const probe = readOverview(worker, agentId)._messagesProbe;
    expect(probe.changeKind).toBe('rewrite');
    expect(probe.count).toBe(2);
    expect(probe.fakeFullBytes).toBe(bytesOf(session.messages));
  });

  it('keeps fakeFullBytes consistent when the byte limit forces a trim', () => {
    const { worker, agentId } = createWorker();
    worker.MAX_BYTES = 10;

    push(worker, agentId, [
      makeMsg('user', 'x'.repeat(50)),
      makeMsg('assistant', 'kept-1'),
      makeMsg('user', 'kept-2'),
    ]);

    const session = worker.agentSessions.get(agentId);
    // 首条即超出 MAX_BYTES：整个前缀被剪掉
    expect(session.messages.map((m: any) => m.content)).toEqual(['kept-1', 'kept-2']);

    const probe = readOverview(worker, agentId)._messagesProbe;
    expect(probe.fakeFullBytes).toBe(bytesOf(session.messages));
  });
});
