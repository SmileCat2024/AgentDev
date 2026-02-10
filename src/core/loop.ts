/**
 * ReAct 循环
 * 最核心的执行逻辑：推理 -> 行动 -> 观察 -> 循环
 */

import type { LLMClient, Message, Tool, ToolCall, LLMResponse } from './types.js';
import { Context } from './context.js';
import { user, assistant, toolResult } from './message.js';

export interface LoopResult {
  content: string;
  turns: number;
  context: Context;
}

/**
 * 执行 ReAct 循环
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
  const { llm, tools, input, maxTurns, systemMessage, onTurn, onMessages } = options;

  // 创建上下文
  const context = new Context();

  // 添加系统消息（如果有）
  if (systemMessage) {
    context.add({ role: 'system', content: systemMessage });
  }

  // 添加用户输入
  context.add(user(input));

  // 推送初始消息
  if (onMessages) {
    onMessages(context.getAll());
  }

  // 循环执行
  for (let turn = 0; turn < maxTurns; turn++) {
    // 1. 调用 LLM
    const response = await llm.chat(context.getAll(), tools);

    // 回调
    if (onTurn) {
      onTurn(turn, response);
    }

    // 2. 添加助手响应到上下文
    context.add(assistant(response.content, response.toolCalls, response.reasoning));

    // 推送消息更新
    if (onMessages) {
      onMessages(context.getAll());
    }

    // 3. 如果没有工具调用，结束循环
    if (!response.toolCalls || response.toolCalls.length === 0) {
      return {
        content: response.content,
        turns: turn + 1,
        context,
      };
    }

    // 4. 执行所有工具调用
    for (const toolCall of response.toolCalls) {
      const result = await executeTool(tools, toolCall);
      context.add(toolResult(toolCall.id, result));
    }

    // 推送工具结果后的消息更新
    if (onMessages) {
      onMessages(context.getAll());
    }
  }

  // 达到最大轮次
  return {
    content: context.getLast()?.content || 'Max turns exceeded',
    turns: maxTurns,
    context,
  };
}

/**
 * 执行单个工具
 */
async function executeTool(tools: Tool[], toolCall: ToolCall): Promise<string> {
  // 查找工具
  const tool = tools.find(t => t.name === toolCall.name);

  if (!tool) {
    return `Error: Tool "${toolCall.name}" not found`;
  }

  // 执行工具
  try {
    const result = await tool.execute(toolCall.arguments);
    return JSON.stringify({ success: true, result });
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
