/**
 * 子代理管理工具集
 * 允许 Agent 创建和管理子代理来执行并行任务
 */

import { createTool } from '../../core/tool.js';
import type { Tool } from '../../core/types.js';
import type { Agent } from '../../core/agent.js';

/**
 * 获取所有子代理状态列表
 */
function getAllAgentsStatus(parentAgent: Agent) {
  const pool = parentAgent.pool;
  const instances = pool.list();

  return instances.map(i => ({
    agentId: i.id,
    type: i.type,
    status: i.status,
  }));
}

/**
 * spawn_agent - 创建子代理
 */
export const spawnAgentTool: Tool = createTool({
  name: 'spawn_agent',
  description: '创建一个子代理实例。子代理创建后处于idle状态，等待通过 send_to_agent 发送指令来激活。返回实例 ID（格式：类型名_序号）。\n\n子代理完成工作后，其结果会自动添加到你的上下文中，你将收到 "[子代理 ID_执行完成]:" 格式的消息。',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: '子代理类型名'
      }
    },
    required: ['type']
  },
  render: { call: 'agent-spawn', result: 'agent-spawn' },
  execute: async ({ type }, context?: { parentAgent?: Agent }) => {
    const parentAgent = context?.parentAgent;
    if (!parentAgent) {
      return { error: '无法获取父代理引用' };
    }

    const pool = parentAgent.pool;
    const agentId = await pool.spawn(type, async (t) => await parentAgent.createAgentByType(t));

    return {
      agentId,
      type,
      status: 'idle',
      allAgents: getAllAgentsStatus(parentAgent),
    };
  },
});

/**
 * list_agents - 查看子代理列表
 */
export const listAgentsTool: Tool = createTool({
  name: 'list_agents',
  description: '列出所有子代理及其状态（ID、类型、状态等）。\n\n注意：子代理的执行结果会自动添加到你的上下文中，你不需要调用此工具来获取结果。此工具主要用于确认子代理正确启动，不要在运行期间不断监控运行情况',
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
        createdAt: i.createdAt,
        result: i.result,
        error: i.error,
      })),
      total: instances.length,
      running: instances.filter(i => i.status === 'busy' || i.status === 'idle').length,
      tips: '当确认子代理工作正常时，你无需重复调用此工具以获取最新状态，可停止输出，等待子代理完成任务后自动添加到上下文中。',
    };
  },
});

/**
 * wait - 等待子代理完成
 */
export const waitTool: Tool = createTool({
  name: 'wait',
  description: '调用本工具后，系统将被阻塞，等待子代理返回运行结果后继续运行。可以与 spawn_agent、send_to_agent 等工具在同一轮一起调用，表示执行完这些操作后等待子代理完成。',
  parameters: {
    type: 'object',
    properties: {},
  },
  render: { call: 'wait', result: 'wait' },
  execute: async (_args, context?: { parentAgent?: Agent }) => {
    const parentAgent = context?.parentAgent;
    if (!parentAgent) {
      return { error: '无法获取父代理引用' };
    }

    const pool = parentAgent.pool;

    // 安全检查：是否有活跃的子代理
    if (!pool.hasActiveAgents()) {
      return {
        error: '当前没有正在执行的子代理（busy状态），调用 wait 无意义。请先使用 spawn_agent 创建子代理或使用 send_to_agent 向子代理发送任务。',
        allAgents: getAllAgentsStatus(parentAgent),
      };
    }

    // 只是一个标志，实际等待逻辑在 agent.ts 的 ReAct 循环中处理
    return {
      action: 'waiting_for_subagents',
      message: '系统将在子代理完成任务后继续...',
      allAgents: getAllAgentsStatus(parentAgent),
    };
  },
});

/**
 * send_to_agent - 向子代理发送消息
 */
export const sendToAgentTool: Tool = createTool({
  name: 'send_to_agent',
  description: '向指定的子代理发送指令。只能向处于idle状态的子代理发送消息，如果子代理正在执行（busy状态），发送会失败。子代理运行期间可以执行其他工作，若无需求，应停止输出或使用wait工具，待子代理完成任务时会主动唤起',
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

    // 检查子代理是否存在以及状态
    const instance = pool.get(agentId);
    if (!instance) {
      return {
        error: `子代理不存在: ${agentId}`,
        allAgents: getAllAgentsStatus(parentAgent),
      };
    }

    // 检查子代理是否正在执行
    if (instance.status === 'busy') {
      return {
        error: `子代理 ${agentId} 正在执行任务（busy状态），无法接收新消息。请等待其完成后再发送`,
        agentId,
        currentStatus: instance.status,
        allAgents: getAllAgentsStatus(parentAgent),
      };
    }

    await pool.sendTo(agentId, message);

    return {
      agentId,
      status: 'message_sent',
      previousStatus: instance.status,
      message: '消息已成功发送到子代理，可以继续执行你尚未完成的其他任务，若无必要，请停止输出，等待子代理完成任务',
      allAgents: getAllAgentsStatus(parentAgent),
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
