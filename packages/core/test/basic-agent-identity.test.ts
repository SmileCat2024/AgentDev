/**
 * BasicAgent 配置透传测试（ADR-0047 阶段 5）
 *
 * 历史缺陷：BasicAgent 构造器用白名单重建 agentConfig，runtimeInputIdentity
 * 不在清单内被静默丢弃——所有继承 BasicAgent 的宿主 agent（编程小助手 /
 * coder 等）spawn 时注入的线程身份永远到不了 Viewer 注册，WorkThread
 * fencing 拒收一切线程指令（阶段 5 真实宿主联测捕获）。契约：宿主经构造
 * 配置传入的身份必须原样到达 Agent 基类（getRuntimeInputIdentity 可回读）。
 */
import { describe, it, expect } from 'vitest';
import { BasicAgent } from '../src/agents/system/BasicAgent.js';

describe('BasicAgent runtimeInputIdentity passthrough', () => {
  it('forwards runtimeInputIdentity to the Agent base config', () => {
    const identity = { runtimeInstanceId: 'ri-1', threadId: 'wt-1', headGeneration: 3, sessionId: 'biz-1' };
    const agent = new BasicAgent({
      llm: { chat: (() => {}) as any, modelName: 'test-model' } as any,
      runtimeInputIdentity: identity,
    });
    expect(agent.getRuntimeInputIdentity()).toEqual(identity);
  });

  it('keeps identity empty when not provided (non-thread runtime semantics unchanged)', () => {
    const agent = new BasicAgent({
      llm: { chat: (() => {}) as any, modelName: 'test-model' } as any,
    });
    expect(agent.getRuntimeInputIdentity()).toEqual({});
  });
});
