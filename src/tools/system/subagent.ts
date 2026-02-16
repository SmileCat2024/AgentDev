/**
 * 子代理管理工具集
 * 允许 Agent 创建和管理子代理来执行并行任务
 */

import { createTool } from '../../core/tool.js';
import type { Tool } from '../../core/types.js';
import type { Agent } from '../../core/agent.js';

/**
 * spawn_agent - 创建子代理
 */
export const spawnAgentTool: Tool = createTool({
  name: 'spawn_agent',
  description: '创建一个子代理来执行指定任务。返回实例 ID（格式：类型名_序号）。\n\n重要：子代理完成后，其结果会自动添加到你的上下文中，你将收到 "[子代理 ID_执行完成]:" 格式的消息。此时你可以直接基于结果继续工作，无需调用 list_agents 确认。\n\n支持的子代理类型：\n- "BasicAgent": 基础代理，配备文件操作和命令执行工具\n- "ExplorerAgent": 代码探索者代理，专注于代码库探索和理解，仅配备 read、list、bash 三个核心工具',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: '子代理类型名，支持 "BasicAgent" 或 "ExplorerAgent"'
      },
      instruction: {
        type: 'string',
        description: '给子代理的初始指令'
      }
    },
    required: ['type', 'instruction']
  },
  render: { call: 'agent-spawn', result: 'agent-spawn' },
  execute: async ({ type, instruction }, context?: { parentAgent?: Agent }) => {
    const parentAgent = context?.parentAgent;
    if (!parentAgent) {
      return { error: '无法获取父代理引用' };
    }

    const pool = parentAgent.pool;
    const agentId = await pool.spawn(type, instruction, async (t) => await parentAgent.createAgentByType(t));

    return {
      agentId,
      type,
      status: 'running'
    };
  },
});

/**
 * list_agents - 查看子代理列表
 */
export const listAgentsTool: Tool = createTool({
  name: 'list_agents',
  description: '列出所有子代理及其状态（ID、类型、状态等）。\n\n注意：子代理的执行结果会自动添加到你的上下文中，你不需要调用此工具来获取结果。此工具主要用于检查子代理的运行状态，而非获取执行结果。',
  parameters: {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        enum: ['all', 'running', 'completed', 'failed', 'terminated'],
        description: '筛选条件，默认显示所有子代理',
        default: 'all'
      }
    }
  },
  render: { call: 'agent-list', result: 'json' },
  execute: async ({ filter = 'all' }, context?: { parentAgent?: Agent }) => {
    const parentAgent = context?.parentAgent;
    if (!parentAgent) {
      return { error: '无法获取父代理引用' };
    }

    const pool = parentAgent.pool;
    const instances = pool.list(filter === 'all' ? undefined : filter as any);

    return {
      agents: instances.map(i => ({
        agentId: i.id,
        type: i.type,
        status: i.status,
        initialInstruction: i.initialInstruction,
        createdAt: i.createdAt,
        result: i.result,
        error: i.error,
      })),
      total: instances.length,
      running: instances.filter(i => i.status === 'running').length,
    };
  },
});

/**
 * send_to_agent - 向子代理发送消息
 */
export const sendToAgentTool: Tool = createTool({
  name: 'send_to_agent',
  description: '向指定的子代理发送后续消息或指令。可以与运行中的子代理进行多轮交互。',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: '子代理实例 ID，如 "BasicAgent_1" 或 "ExplorerAgent_2"'
      },
      message: {
        type: 'string',
        description: '要发送给子代理的消息或指令'
      }
    },
    required: ['agentId', 'message']
  },
  render: { call: 'agent-send', result: 'json' },
  execute: async ({ agentId, message }, context?: { parentAgent?: Agent }) => {
    const parentAgent = context?.parentAgent;
    if (!parentAgent) {
      return { error: '无法获取父代理引用' };
    }

    const pool = parentAgent.pool;
    await pool.sendTo(agentId, message);

    return {
      agentId,
      status: 'message_sent',
      message: '消息已发送到子代理'
    };
  },
});

/**
 * close_agent - 关闭子代理
 */
export const closeAgentTool: Tool = createTool({
  name: 'close_agent',
  description: '关闭指定的子代理并释放其资源。子代理将被终止并从池中移除。',
  parameters: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: '要关闭的子代理实例 ID'
      },
      reason: {
        type: 'string',
        description: '关闭原因（可选）',
        default: 'manual'
      }
    },
    required: ['agentId']
  },
  render: { call: 'agent-close', result: 'json' },
  execute: async ({ agentId, reason = 'manual' }, context?: { parentAgent?: Agent }) => {
    const parentAgent = context?.parentAgent;
    if (!parentAgent) {
      return { error: '无法获取父代理引用' };
    }

    const pool = parentAgent.pool;
    await pool.close(agentId, reason);

    return {
      agentId,
      status: 'closed',
      message: `子代理 ${agentId} 已关闭`
    };
  },
});
