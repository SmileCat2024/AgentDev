/**
 * ReAct 循环
 * 最核心的执行逻辑：推理 -> 行动 -> 观察 -> 循环
 */

import type { LLMClient, Message, Tool, ToolCall, LLMResponse } from './types.js';
import { Context } from './context.js';
import { Agent } from './agent.js';

export interface LoopResult {
  content: string;
  turns: number;
  context: Context;
}

/**
 * @deprecated 使用 Agent.onCall() 代替
 *
 * 向后兼容层：内部创建临时 Agent 实例，调用新的 onCall() 方法
 */
export async function runReactLoop(options: {
  llm: LLMClient;
  tools: Tool[];
  input: string;
  maxTurns: number;
  systemMessage?: string;
  onTurn?: (turn: number, response: LLMResponse) => void;
  onMessages?: (messages: Message[]) => void;
}): Promise<LoopResult> {
  console.warn('[DEPRECATED] runReactLoop is deprecated, use Agent.onCall() instead');

  const { llm, tools, input, maxTurns, systemMessage } = options;

  // 创建临时 Agent 实例，调用新的 onCall 方法
  const agent = new Agent({
    llm,
    tools,
    maxTurns,
    systemMessage,
  });

  const result = await agent.onCall(input);

  // 获取上下文用于返回
  const context = agent['persistentContext'] as Context | undefined;

  return {
    content: result,
    turns: context ? Math.floor((context.getAll().length - 1) / 2) : 1,
    context: context ?? new Context(),
  };
}
