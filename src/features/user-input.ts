/**
 * UserInputFeature - 通过调试界面获取用户输入
 *
 * 功能：
 * - 提供 get_user_input 工具，允许 LLM 请求用户输入
 * - 通过 DebugHub 的 UDS 通道与 ViewerWorker 通信
 * - 前端显示输入框，用户提交后返回给 Agent
 */

import { createTool } from '../core/tool.js';
import type { Tool } from '../core/types.js';
import type { AgentFeature, FeatureInitContext, FeatureContext } from '../core/feature.js';
import { DebugHub } from '../core/debug-hub.js';

export interface UserInputFeatureConfig {
  /** 默认超时时间（毫秒），默认 5 分钟 */
  timeout?: number;
}

export class UserInputFeature implements AgentFeature {
  readonly name = 'user-input';
  readonly dependencies: string[] = [];

  private agent?: any;  // 保存 Agent 引用，实时获取 debugHub
  private agentId?: string;
  private defaultTimeout: number;

  constructor(config: UserInputFeatureConfig = {}) {
    this.defaultTimeout = config.timeout ?? 300000; // 5 分钟
  }

  /**
   * 设置父 Agent 引用（由 Agent.use() 调用）
   */
  _setParentAgent(agent: any): void {
    this.agent = agent;
    this.agentId = agent.agentId;
  }

  /**
   * 请求用户输入（核心方法）
   */
  async requestUserInput(prompt: string, timeout?: number): Promise<string> {
    // 实时获取 debugHub（支持 use() 在 withViewer() 之前调用的情况）
    const debugHub = this.agent?.debugHub;
    if (!debugHub) {
      throw new Error('DebugHub not available. UserInputFeature requires withViewer() to be called first.');
    }
    const agentId = this.agent?.agentId ?? this.agentId;
    if (!agentId) {
      throw new Error('Agent ID not available. Ensure the agent is properly initialized.');
    }

    return debugHub.requestUserInput(
      agentId,
      prompt,
      timeout ?? this.defaultTimeout
    );
  }

  /**
   * 获取用户输入（公开接口，供主循环直接调用）
   * @param prompt 提示信息
   * @param timeout 超时时间（毫秒）
   * @returns 用户输入内容
   */
  async getUserInput(prompt: string = '请输入：', timeout?: number): Promise<string> {
    return this.requestUserInput(prompt, timeout);
  }

  getTools(): Tool[] {
    return [
      createTool({
        name: 'get_user_input',
        description: '请求用户通过调试界面输入文本。当需要用户确认或补充信息时使用。',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: '提示用户输入的问题或说明'
            }
          },
          required: ['prompt']
        },
        execute: async ({ prompt }) => {
          const input = await this.requestUserInput(prompt);
          return { input };
        },
      }),
    ];
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    // 记录 agentId（可能在 _setParentAgent 中被覆盖）
    this.agentId = ctx.agentId;
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    // 清理资源（如有）
  }
}
