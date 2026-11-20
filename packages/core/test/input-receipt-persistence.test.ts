/** Durable input receipt ordering and backwards-compatibility tests. */
import { describe, it, expect } from 'vitest';
import { Agent } from '../src/core/agent.js';
import type { AgentSessionSnapshot, SessionStore } from '../src/core/session-store.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';

const receipt = {
  commandId: 'cmd-durable-1',
  threadId: 'wt-1',
  headGeneration: 2,
  leaseId: 'lease-1',
  sessionId: 'session-1',
  runtimeInstanceId: 'runtime-1',
};

class SnapshotStore implements SessionStore {
  snapshots: AgentSessionSnapshot[] = [];
  fail = false;
  async save(_sessionId: string, snapshot: AgentSessionSnapshot) {
    if (this.fail) throw new Error('disk unavailable');
    this.snapshots.push(structuredClone(snapshot));
    return '/tmp/session.json';
  }
  async load(): Promise<AgentSessionSnapshot> { throw new Error('unused'); }
  async list(): Promise<string[]> { return []; }
  async delete(): Promise<void> {}
}

class InspectingLLM implements LLMClient {
  snapshotAtCall: AgentSessionSnapshot | undefined;
  order: string[];
  constructor(order: string[], private store: SnapshotStore) { this.order = order; }
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    this.order.push('llm');
    this.snapshotAtCall = this.store.snapshots.at(-1);
    // Receipt is durable metadata only and must not be exposed to model messages.
    expect(messages.some((m) => (m as any).inputReceipt)).toBe(false);
    return { content: 'done' };
  }
}

describe('durable input receipt', () => {
  it('saves the identity-bearing running snapshot before acknowledging or calling the model', async () => {
    const order: string[] = [];
    const store = new SnapshotStore();
    const llm = new InspectingLLM(order, store);
    const agent = new Agent({ llm, maxTurns: 1 });
    agent.enableStepAutoSave('session-1', store);

    await agent.onCallDetailed('do work', [], [], undefined, {
      inputReceipt: receipt,
      acknowledgeInputReceipt: async (identity) => {
        order.push('ack');
        expect(identity).toEqual(receipt);
        const messages = store.snapshots.at(-1)?.runtime.context?.messages || [];
        expect(messages.some((message) => message.inputReceipt?.commandId === receipt.commandId)).toBe(true);
        expect(store.snapshots.at(-1)?.runtime.callState).toBe('running');
      },
    });

    expect(order).toEqual(['ack', 'llm']);
    expect(llm.snapshotAtCall?.runtime.context?.messages.some((message) => message.inputReceipt?.commandId === receipt.commandId)).toBe(true);
  });

  it('does not acknowledge or call the model if the receipt snapshot cannot be saved', async () => {
    const store = new SnapshotStore();
    store.fail = true;
    let acked = false;
    let modelCalls = 0;
    const llm: LLMClient = { async chat() { modelCalls++; return { content: 'unexpected' }; } };
    const agent = new Agent({ llm, maxTurns: 1 });
    agent.enableStepAutoSave('session-1', store);

    await expect(agent.onCallDetailed('do work', [], [], undefined, {
      inputReceipt: receipt,
      acknowledgeInputReceipt: async () => { acked = true; },
    })).rejects.toThrow('disk unavailable');
    expect(acked).toBe(false);
    expect(modelCalls).toBe(0);
  });

  it('keeps ordinary calls on the existing path without requiring receipt configuration', async () => {
    let modelCalls = 0;
    const llm: LLMClient = { async chat() { modelCalls++; return { content: 'done' }; } };
    const agent = new Agent({ llm, maxTurns: 1 });
    await agent.onCallDetailed('ordinary input');
    expect(modelCalls).toBe(1);
    expect(agent.getContext().getAll()[0]?.inputReceipt).toBeUndefined();
  });

  it('does not duplicate the receipt message when the same command is re-persisted under a fresh leaseId (stage 5 review P2-8)', async () => {
    // 重启恢复场景：快照已含该命令的回执消息，runtime 重新 claim 后
    // leaseId 必然换新（领取实例标识），命令身份三元组不变。幂等口径
    // 必须是三元组——纳入 leaseId 会让「快照已含 → 只补 ack、不重复
    // 追加」失效，同一命令在上下文出现两次并重复执行语义。
    const store = new SnapshotStore();
    const llm: LLMClient = { async chat() { return { content: 'done' }; } };
    const agent = new Agent({ llm, maxTurns: 1 });
    agent.enableStepAutoSave('session-1', store);

    // drain 路径总在活跃 call 内运行（persistentContext 已建立）；
    // 用一个普通回合建立同等前置状态，再驱动回执边界方法本体。
    await agent.onCallDetailed('bootstrap turn');

    const countReceiptMessages = () =>
      agent.getContext().getAll().filter((m) => (m as any).inputReceipt?.commandId === 'cmd-reclaim-1').length;

    const persist = (leaseId: string) => (agent as any)._persistInputReceiptDurable(agent.getContext(), {
      text: 'do work',
      receipt: { ...receipt, commandId: 'cmd-reclaim-1', leaseId },
    });

    const snapshotsBefore = store.snapshots.length;
    await persist('lease-first');
    expect(countReceiptMessages()).toBe(1);

    await persist('lease-reclaimed'); // 重启后重新 claim：leaseId 换新
    expect(countReceiptMessages()).toBe(1); // 三元组幂等：不重复追加
    expect(store.snapshots.length).toBe(snapshotsBefore + 2); // 每次边界仍落快照（补 ack 前置）

  });
});

describe('plain-turn pre-execution persistence', () => {
  it('persists the user message before the first model call of the turn', async () => {
    // 复现锚：新会话首轮、首个 step（模型调用 + 工具执行）尚未完成时，
    // 磁盘快照必须已含本轮用户输入——否则只读磁盘的消费方（会话引用、
    // 崩溃恢复）在长首 step 窗口内读到空记录。观察点放在模型调用时刻：
    // 那时 step 保存尚未触发，快照只能来自 callUserInput 的预保存边界。
    const store = new SnapshotStore();
    let snapshotAtCall: AgentSessionSnapshot | undefined;
    const llm: LLMClient = {
      async chat() {
        snapshotAtCall = store.snapshots.at(-1);
        return { content: 'done' };
      },
    };
    const agent = new Agent({ llm, maxTurns: 1 });
    agent.enableStepAutoSave('session-1', store);

    await agent.onCallDetailed('plain turn input');

    const messages = snapshotAtCall?.runtime.context?.messages || [];
    expect(messages.some((message) => message.role === 'user' && message.content === 'plain turn input')).toBe(true);
  });

  it('does not block the turn when the pre-execution save fails', async () => {
    // 与 durable receipt 边界不同：普通输入的预保存失败不阻断本轮执行，
    // step 保存与 call-finish 保存仍然兜底。
    const store = new SnapshotStore();
    store.fail = true;
    let modelCalls = 0;
    const llm: LLMClient = { async chat() { modelCalls++; return { content: 'done' }; } };
    const agent = new Agent({ llm, maxTurns: 1 });
    agent.enableStepAutoSave('session-1', store);

    await agent.onCallDetailed('plain turn input');
    expect(modelCalls).toBe(1);
  });

  it('skips the pre-execution save when no session store is enabled', async () => {
    // 无 stepAutoSave 的调用方（无会话存储的 plain agent）行为不变。
    let modelCalls = 0;
    const llm: LLMClient = { async chat() { modelCalls++; return { content: 'done' }; } };
    const agent = new Agent({ llm, maxTurns: 1 });

    await agent.onCallDetailed('plain turn input');
    expect(modelCalls).toBe(1);
  });
});
