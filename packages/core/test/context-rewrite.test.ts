/**
 * Context 历史改写原语测试（ADR-0023 / PR-1）
 *
 * 覆盖：
 * - apply() 双数组同步（messages / enrichedMessages 对齐 + 索引重建）
 * - rewriteToolCall() 命中 / 未命中 / 快照保护 / 索引 / 持久化往返 / boundary 兼容
 */

import { describe, it, expect } from 'vitest';
import { Context } from '../src/core/context.js';
import type { ToolCall, LLMResponse } from '../src/core/types.js';

/** 构造含一次 assistant 工具调用消息的 Context。 */
function makeToolCallContext(...calls: ToolCall[]): Context {
  const ctx = new Context();
  ctx.addUserMessage('run it', 0);
  const response: LLMResponse = { content: '', toolCalls: [...calls] };
  ctx.addAssistantMessage(response, 0);
  return ctx;
}

describe('Context.apply 双数组同步', () => {
  it('filter 后 getAllEnriched 与 getAll 逐条对齐，幸存消息保留 enriched 元数据', () => {
    const ctx = new Context();
    ctx.addUserMessage('a', 0);
    ctx.addAssistantMessage({ content: 'calling', toolCalls: [{ id: 'tc_1', name: 'read', arguments: { p: 1 } }] }, 0);
    ctx.addUserMessage('b', 1);
    const enrichedBefore = ctx.getAllEnriched();
    const survivorId = enrichedBefore[1].id; // assistant（幸存），user-a 被过滤

    ctx.apply(msgs => msgs.filter(m => m.content !== 'a'));

    const messages = ctx.getAll();
    const enriched = ctx.getAllEnriched();
    expect(messages).toHaveLength(2);
    expect(enriched).toHaveLength(2);
    expect(enriched.map(m => m.role)).toEqual(messages.map(m => m.role));
    expect(enriched.map(m => m.content)).toEqual(messages.map(m => m.content ?? ''));
    // 幸存消息的 enriched 元数据保持稳定（id 不变）
    expect(enriched[0].id).toBe(survivorId);
  });

  it('middleware 新增消息获得全新 enriched 条目', () => {
    const ctx = new Context();
    ctx.addUserMessage('a', 0);

    ctx.apply(msgs => [...msgs, { role: 'user', content: 'extra', turn: 1 }]);

    expect(ctx.getAllEnriched()).toHaveLength(2);
    expect(ctx.getAllEnriched()[1].id).toBeDefined();
    expect(ctx.getAllEnriched()[1].turn).toBe(1);
  });

  it('apply 后查询索引按新数组重建（byTool 生效）', () => {
    const ctx = makeToolCallContext({ id: 'tc_1', name: 'read', arguments: {} });
    ctx.addUserMessage('again', 1);
    ctx.addAssistantMessage({ content: '', toolCalls: [{ id: 'tc_2', name: 'write', arguments: {} }] }, 1);

    ctx.apply(msgs => msgs.filter(m => !(m.role === 'assistant' && m.toolCalls?.some(c => c.name === 'write'))));

    // 第二条 assistant（write 调用）被过滤掉：read 仍可经索引命中，
    // 消息内容中不再存在 write（byTool 对索引缺失的键是 no-op，故用 groupByTool 断言内容）
    expect(ctx.query().byTool('read').count()).toBe(1);
    expect(ctx.query().byRole('assistant').groupByTool()).toEqual({ read: 1 });
    expect(ctx.getAllEnriched()).toHaveLength(ctx.getAll().length);
  });
});

describe('Context.rewriteToolCall（ADR-0023）', () => {
  const original: ToolCall = { id: 'tc_1', name: 'read_file', arguments: { path: './a.ts' } };
  const effective: ToolCall = { id: 'tc_1', name: 'read', arguments: { path: 'D:/abs/a.ts' } };

  it('命中：两侧历史替换为新调用，id 不变，返回 true', () => {
    const ctx = makeToolCallContext(original);

    const hit = ctx.rewriteToolCall(effective);

    expect(hit).toBe(true);
    const assistant = ctx.getAll().find(m => m.role === 'assistant')!;
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls![0].name).toBe('read');
    expect(assistant.toolCalls![0].arguments).toEqual({ path: 'D:/abs/a.ts' });
    expect(assistant.toolCalls![0].id).toBe('tc_1');

    const enrichedAssistant = ctx.getAllEnriched().find(m => m.role === 'assistant')!;
    expect(enrichedAssistant.toolCalls![0].name).toBe('read');
    expect(enrichedAssistant.parsed.toolCalls).toEqual(['read']);
  });

  it('不污染已发射对象：原 toolCalls 数组与原 ToolCall 对象保持原值', () => {
    const source: ToolCall[] = [{ ...original }];
    const ctx = new Context();
    ctx.addAssistantMessage({ content: '', toolCalls: source }, 0);

    ctx.rewriteToolCall(effective);

    // 原数组（模拟已推送的 DebugHub 快照 / react-loop 手里的引用）不变
    expect(source[0].name).toBe('read_file');
    expect(source[0].arguments).toEqual({ path: './a.ts' });
  });

  it('索引重建：新工具名可检索，旧工具名不再出现', () => {
    const ctx = makeToolCallContext(original);

    ctx.rewriteToolCall(effective);

    expect(ctx.query().byTool('read').count()).toBe(1);
    // byTool 对索引缺失的键是 no-op（返回全部），故旧名缺席用内容聚合断言
    expect(ctx.query().byRole('assistant').groupByTool()).toEqual({ read: 1 });
  });

  it('同消息多个 toolCall 时只替换目标 id，兄弟调用不动', () => {
    const sibling: ToolCall = { id: 'tc_2', name: 'list', arguments: { dir: '.' } };
    const ctx = makeToolCallContext(original, sibling);

    ctx.rewriteToolCall(effective);

    const assistant = ctx.getAll().find(m => m.role === 'assistant')!;
    expect(assistant.toolCalls).toHaveLength(2);
    expect(assistant.toolCalls![0]).toMatchObject({ id: 'tc_1', name: 'read' });
    expect(assistant.toolCalls![1]).toEqual(sibling);
  });

  it('未命中（id 不存在）：返回 false，历史不变', () => {
    const ctx = makeToolCallContext(original);
    const before = ctx.getAll();

    const hit = ctx.rewriteToolCall({ id: 'tc_missing', name: 'read', arguments: {} });

    expect(hit).toBe(false);
    expect(ctx.getAll().find(m => m.role === 'assistant')!.toolCalls![0].name).toBe('read_file');
    expect(before).toEqual(ctx.getAll());
  });

  it('toJSON 快照含改写后调用，restore 往返一致', () => {
    const ctx = makeToolCallContext(original);
    ctx.addToolMessage(original, { success: true, result: 'ok' }, 0);

    ctx.rewriteToolCall(effective);

    const snapshot = ctx.toJSON();
    const restored = Context.fromJSON(snapshot);
    const assistant = restored.getAll().find(m => m.role === 'assistant')!;
    expect(assistant.toolCalls![0].name).toBe('read');
    expect(assistant.toolCalls![0].arguments).toEqual({ path: 'D:/abs/a.ts' });
    // tool 消息与改写后调用仍按 id 配对
    expect(restored.getAll().find(m => m.role === 'tool')!.toolCallId).toBe('tc_1');
  });

  it('generation 不递增，改写前捕获的 boundary 仍可截断', () => {
    const ctx = new Context();
    ctx.addUserMessage('run it', 0);
    const boundary = ctx.captureBoundary();
    ctx.addAssistantMessage({ content: '', toolCalls: [{ ...original }] }, 0);

    ctx.rewriteToolCall(effective);
    expect(ctx.getGeneration()).toBe(boundary.generation);

    ctx.addUserMessage('after', 1);
    expect(() => ctx.truncateToBoundary(boundary)).not.toThrow();
    // 截断回到 boundary：assistant 消息（含改写后调用）被移除
    expect(ctx.getAll().find(m => m.role === 'assistant')).toBeUndefined();
  });
});
