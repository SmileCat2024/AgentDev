/**
 * WorkThreadRuntimeBridge 测试（ticket 007）。
 *
 * 自 Claw `test/thread-control.test.js` 的 ThreadRuntimeBridge 部分随迁。
 * 覆盖：休眠默认、启用后投递、runtime 未就绪重试、非重试失败标记、以及
 * 「bridge 传给 submitTurn 的参数名必须是 agentId」契约回归。
 */

import { describe, it, expect } from 'vitest';
import {
  WorkThreadRuntimeBridge,
  RUNTIME_NOT_ACCEPTING_REASON,
  WORKTHREAD_BRIDGE_DISABLED_REASON,
  buildRuntimeKey,
} from '../../core/workthread/bridge.js';

class UserTurnDeliveryError extends Error {
  code: string;
  retryable: boolean;
  constructor(message: string, opts: { code: string; retryable?: boolean }) {
    super(message);
    this.name = 'UserTurnDeliveryError';
    this.code = opts.code;
    this.retryable = opts.retryable !== false;
  }
}

const thread = { agentId: 'agent-x', headSessionId: 'head-1', threadId: 'wt-1' };
const command = { commandId: 'cmd-1', text: '请继续' };

describe('WorkThreadRuntimeBridge', () => {
  it('disabled by default returns bridge_disabled (retryable)', async () => {
    const bridge = new WorkThreadRuntimeBridge();
    expect(bridge.isEnabled()).toBe(false);
    const outcome = await bridge.deliver({ thread, command });
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe(WORKTHREAD_BRIDGE_DISABLED_REASON);
    expect(outcome.retryable).toBe(true);
  });

  it('runtime not ready (resolveRuntimeViewerId null) keeps pending retryable', async () => {
    const bridge = new WorkThreadRuntimeBridge({
      enabled: true,
      resolveRuntimeViewerId: () => null,
    });
    const outcome = await bridge.deliver({ thread, command });
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe(RUNTIME_NOT_ACCEPTING_REASON);
    expect(outcome.retryable).toBe(true);
  });

  it('invalid thread target is non-retryable', async () => {
    const bridge = new WorkThreadRuntimeBridge({ enabled: true, resolveRuntimeViewerId: () => 'v' });
    const outcome = await bridge.deliver({ thread: { agentId: '', headSessionId: '' }, command });
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('invalid_thread_target');
    expect(outcome.retryable).toBe(false);
  });

  it('delivers to resolved viewer via submitTurn with deliveryRef', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const bridge = new WorkThreadRuntimeBridge({
      enabled: true,
      resolveRuntimeViewerId: (agentId, sessionId) => {
        return agentId === 'agent-x' && sessionId === 'head-1' ? 'viewer-abc' : null;
      },
      submitTurn: async (params) => {
        seen.push(params);
        return { success: true };
      },
    });
    const outcome = await bridge.deliver({ thread, command });
    expect(outcome.accepted).toBe(true);
    expect(outcome.deliveryRef).toBe('viewer-abc');
    expect(seen.length).toBe(1);
    expect(seen[0].agentId).toBe('viewer-abc');
    expect(seen[0].text).toBe('请继续');
    expect(seen[0].source).toBe('thread');
    expect(seen[0].sourceRef).toBe('cmd-1');
  });

  it('non-retryable delivery failure is surfaced with code', async () => {
    const bridge = new WorkThreadRuntimeBridge({
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-live',
      submitTurn: async () => {
        throw new UserTurnDeliveryError('bad input', { code: 'invalid_input', retryable: false });
      },
    });
    const outcome = await bridge.deliver({ thread, command });
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('invalid_input');
    expect(outcome.retryable).toBe(false);
  });

  it('generic delivery failure is retryable', async () => {
    const bridge = new WorkThreadRuntimeBridge({
      enabled: true,
      resolveRuntimeViewerId: () => 'viewer-live',
      submitTurn: async () => {
        throw new Error('boom');
      },
    });
    const outcome = await bridge.deliver({ thread, command });
    expect(outcome.accepted).toBe(false);
    expect(outcome.reason).toBe('delivery_failed');
    expect(outcome.retryable).toBe(true);
  });

  it('buildRuntimeKey composes agentId::sessionId', () => {
    expect(buildRuntimeKey('coder', 's-1')).toBe('coder::s-1');
  });
});
