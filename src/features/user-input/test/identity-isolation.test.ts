/**
 * UserInputFeature 身份隔离测试
 *
 * 验证 UserInputFeature 在 install 时保存 agentId，
 * 后续请求使用保存的 agentId 而非 DebugHub.getCurrentAgentId()。
 * 这是多 Agent 同进程场景下的关键隔离保障。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserInputResponse } from '../../core/types.js';

// Shared mock instance — getInstance() must always return the same object
const mockRequestUserInputEvent = vi.fn();
const mockGetCapabilities = vi.fn(() => ({
  interactiveInput: true,
  transportMode: 'viewer-worker' as const,
  runtimeUrl: 'http://localhost:2026',
}));

const mockDebugHubInstance = {
  requestUserInputEvent: mockRequestUserInputEvent,
  getCapabilities: mockGetCapabilities,
  getCurrentAgentId: () => 'WRONG_GLOBAL_AGENT', // 模拟全局状态指向错误的 agent
  isAgentRegistered: () => true,
  isConnected: () => true,
  cancelInputRequests: vi.fn(),
};

vi.mock('../../../core/debug-hub.js', () => ({
  DebugHub: {
    getInstance: () => mockDebugHubInstance,
  },
}));

import { UserInputFeature } from '../index.js';
import type { FeatureInitContext } from '../../../core/feature.js';

function makeInitContext(agentId: string): FeatureInitContext {
  return {
    agentId,
    config: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    getFeature: vi.fn(() => undefined),
    registerTool: vi.fn(),
  };
}

describe('UserInputFeature 身份隔离', () => {

  beforeEach(() => {
    mockRequestUserInputEvent.mockReset();
  });

  it('onInitiate 应保存 agentId', async () => {
    const feature = new UserInputFeature();
    await feature.onInitiate?.(makeInitContext('agent-AAA'));
    // 内部状态验证：通过后续 requestUserInputEvent 间接验证
    mockRequestUserInputEvent.mockResolvedValue({ kind: 'text', text: 'ok' } as UserInputResponse);

    await feature.requestUserInputEvent({ prompt: 'test' });

    expect(mockRequestUserInputEvent).toHaveBeenCalledTimes(1);
    const [usedAgentId] = mockRequestUserInputEvent.mock.calls[0];
    expect(usedAgentId).toBe('agent-AAA');
  });

  it('requestUserInputEvent 应使用 install 时的 agentId，而非 getCurrentAgentId()', async () => {
    const feature = new UserInputFeature();
    await feature.onInitiate?.(makeInitContext('agent-CORRECT'));

    mockRequestUserInputEvent.mockResolvedValue({ kind: 'text', text: 'response' } as UserInputResponse);
    await feature.requestUserInputEvent({ prompt: 'hello' });

    // DebugHub.getCurrentAgentId() 返回 'WRONG_GLOBAL_AGENT'，
    // 但 UserInputFeature 应使用自己 install 时保存的 'agent-CORRECT'
    const [usedAgentId] = mockRequestUserInputEvent.mock.calls[0];
    expect(usedAgentId).toBe('agent-CORRECT');
    expect(usedAgentId).not.toBe('WRONG_GLOBAL_AGENT');
  });

  it('多个 UserInputFeature 实例应各自使用自己的 agentId', async () => {
    const featureA = new UserInputFeature();
    const featureB = new UserInputFeature();

    await featureA.onInitiate?.(makeInitContext('agent-ALPHA'));
    await featureB.onInitiate?.(makeInitContext('agent-BETA'));

    mockRequestUserInputEvent.mockResolvedValue({ kind: 'text', text: 'ok' } as UserInputResponse);

    await featureA.requestUserInputEvent({ prompt: 'from A' });
    await featureB.requestUserInputEvent({ prompt: 'from B' });

    expect(mockRequestUserInputEvent).toHaveBeenCalledTimes(2);
    expect(mockRequestUserInputEvent.mock.calls[0][0]).toBe('agent-ALPHA');
    expect(mockRequestUserInputEvent.mock.calls[1][0]).toBe('agent-BETA');
  });

  it('未调用 onInitiate 时应抛出明确错误', async () => {
    const feature = new UserInputFeature();
    // 不调用 onInitiate

    await expect(
      feature.requestUserInputEvent({ prompt: 'test' })
    ).rejects.toThrow(/onInitiate/i);
  });

  // ========== round-trip 字段透传 ==========

  describe('round-trip 字段透传', () => {
    it('requestUserInputEvent 应透传 prompt + initialValue + actions', async () => {
      const feature = new UserInputFeature();
      await feature.onInitiate?.(makeInitContext('rt-agent'));

      mockRequestUserInputEvent.mockResolvedValue({ kind: 'text', text: '' } as UserInputResponse);

      await feature.requestUserInputEvent({
        prompt: '请选择',
        placeholder: '提示文字',
        actions: [{ id: 'cancel', label: '取消' }],
        initialValue: '初始值',
      });

      const [agentId, request, timeout] = mockRequestUserInputEvent.mock.calls[0];
      expect(agentId).toBe('rt-agent');
      expect(request.prompt).toBe('请选择');
      expect(request.placeholder).toBe('提示文字');
      expect(request.actions).toEqual([{ id: 'cancel', label: '取消' }]);
      expect(request.initialValue).toBe('初始值');
      expect(timeout).toBeTypeOf('number');
    });

    it('getUserInputEvent 应透传 prompt + actions', async () => {
      const feature = new UserInputFeature();
      await feature.onInitiate?.(makeInitContext('rt-agent'));

      mockRequestUserInputEvent.mockResolvedValue({ kind: 'text', text: 'hello' } as UserInputResponse);

      await feature.getUserInputEvent('输入指令', undefined, [
        { id: 'exit', label: '退出' },
      ]);

      const [agentId, request] = mockRequestUserInputEvent.mock.calls[0];
      expect(agentId).toBe('rt-agent');
      expect(request.prompt).toBe('输入指令');
      expect(request.actions).toEqual([{ id: 'exit', label: '退出' }]);
    });
  });
});
