/**
 * UserInputFeature - 通过调试界面获取用户输入
 *
 * 功能：
 * - 提供 get_user_input 工具，允许 LLM 请求用户输入
 * - 通过 DebugHub 的 UDS 通道与 ViewerWorker 通信
 * - 前端显示输入框，用户提交后返回给 Agent
 */

import { createTool } from '../../core/tool.js';
import type { Tool } from '../../core/types.js';
import type { AgentFeature, FeatureInitContext, FeatureContext } from '../../core/feature.js';
import { DebugHub } from '../../core/debug-hub.js';

export interface UserInputFeatureConfig {
  /** 默认超时时间（毫秒），默认 5 分钟 */
  timeout?: number;
}

export class UserInputFeature implements AgentFeature {
  readonly name = 'user-input';
  readonly dependencies: string[] = [];

  private defaultTimeout: number;

  constructor(config: UserInputFeatureConfig = {}) {
    this.defaultTimeout = config.timeout ?? 300000; // 5 分钟
  }

  /**
   * 请求用户输入（核心方法）
   */
  async requestUserInput(prompt: string, timeout?: number): Promise<string> {
    // 直接获取 DebugHub 实例
    const debugHub = DebugHub.getInstance();

    // 获取当前注册的 agentId（从 DebugHub）
    const agentId = debugHub.getCurrentAgentId();

    if (!agentId) {
      throw new Error('Agent ID not available. UserInputFeature requires withViewer() to be called first.');
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

  async onInitiate(_ctx: FeatureInitContext): Promise<void> {
    // 不再需要保存 agentId，直接从 DebugHub 获取
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    // 清理资源（如有）
  }

  /**
   * 模板路径声明（无模板）
   */
  getTemplatePaths(): Record<string, string> {
    return {};
  }
}
