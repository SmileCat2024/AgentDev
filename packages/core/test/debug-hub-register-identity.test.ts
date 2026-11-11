/**
 * RegisterAgentMsg 身份字段映射测试（ADR-0047 阶段 5）
 *
 * 历史缺陷：DebugHub UDS 发送端原样展开 Agent 身份对象（键名 sessionId），
 * 而 RegisterAgentMsg 契约与 viewer 读取端使用 workSessionId——身份从未
 * 落到 viewer 会话，WorkThread fencing 拒收一切线程指令（真实宿主联测
 * 捕获）。契约：UDS 发送点（首注册 / 重注册 / 身份采纳重注册）必须经
 * toRegisterIdentity 映射为契约字段名；claw HTTP 通道由 claw-debug-client
 * 自行映射，不经 DebugHub 映射。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { DebugHub } from '../src/core/debug-hub.js';

describe('DebugHub register identity field mapping (UDS)', () => {
  const hub = DebugHub.getInstance();
  let captured: any[] = [];
  let originalSendToWorker: any;

  afterEach(() => {
    (hub as any).sendToWorker = originalSendToWorker;
    (hub as any).agents.clear();
    hub.stop();
    vi.restoreAllMocks();
  });

  function seedAgent(identity: object): void {
    (hub as any).transportMode = 'uds';
    const agents: Map<string, any> = (hub as any).agents;
    agents.clear();
    agents.set('agent-map-1', {
      info: { id: 'agent-map-1', name: 'MapTest', registeredAt: 1, projectRoot: '/tmp' },
      agent: {
        getRuntimeInputIdentity: () => ({ ...identity }),
        buildHookInspectorSnapshot: () => ({}),
        buildOverviewSnapshot: () => ({}),
      },
    });
  }

  function captureSend(): void {
    captured = [];
    originalSendToWorker = (hub as any).sendToWorker;
    (hub as any).sendToWorker = (msg: any) => { captured.push(msg); return true; };
  }

  it('reregisterAgentIdentity maps sessionId to contract workSessionId', () => {
    seedAgent({ runtimeInstanceId: 'ri-1', threadId: 'wt-1', headGeneration: 2, sessionId: 'biz-1' });
    captureSend();
    const pushed = hub.reregisterAgentIdentity('agent-map-1');
    expect(pushed).toBe(true);
    expect(captured).toHaveLength(1);
    const msg = captured[0];
    expect(msg.type).toBe('register-agent');
    expect(msg.workSessionId).toBe('biz-1');
    expect(msg.sessionId).toBeUndefined();
    expect(msg.threadId).toBe('wt-1');
    expect(msg.headGeneration).toBe(2);
    expect(msg.runtimeInstanceId).toBe('ri-1');
  });

  it('reregisterAgentIdentity omits absent identity fields instead of writing undefined', () => {
    seedAgent({});
    captureSend();
    expect(hub.reregisterAgentIdentity('agent-map-1')).toBe(true);
    const msg = captured[0];
    expect('workSessionId' in msg).toBe(false);
    expect('threadId' in msg).toBe(false);
    expect('headGeneration' in msg).toBe(false);
    expect('runtimeInstanceId' in msg).toBe(false);
  });

  it('reregisterAgentIdentity returns false for unregistered agent', () => {
    seedAgent({});
    captureSend();
    expect(hub.reregisterAgentIdentity('agent-absent')).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it('registerAgent maps runtimeIdentity sessionId on first UDS registration', () => {
    seedAgent({});
    captureSend();
    const fakeAgent: any = {
      getRuntimeInputIdentity: () => ({ threadId: 'wt-2', headGeneration: 1, sessionId: 'biz-2' }),
    };
    hub.registerAgent(
      fakeAgent,
      'FirstReg',
      0,
      {},
      {},
      {},
      '/tmp',
      'agent-map-first',
      undefined,
      { threadId: 'wt-2', headGeneration: 1, sessionId: 'biz-2' },
    );
    const msg = captured.find((m) => m.type === 'register-agent' && m.agentId === 'agent-map-first');
    expect(msg).toBeDefined();
    expect(msg.workSessionId).toBe('biz-2');
    expect(msg.sessionId).toBeUndefined();
    expect(msg.threadId).toBe('wt-2');
  });
});
