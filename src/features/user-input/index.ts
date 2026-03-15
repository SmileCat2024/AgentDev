/**
 * UserInputFeature - 通过调试界面获取用户输入
 *
 * 功能：
 * - 提供 get_user_input 工具，允许 LLM 请求用户输入
 * - 通过 DebugHub 的 UDS 通道与 ViewerWorker 通信
 * - 前端显示输入框，用户提交后返回给 Agent
 */

import { fileURLToPath } from 'url';
import { createTool } from '../../core/tool.js';
import type { Tool, UserInputAction, UserInputRequest, UserInputResponse } from '../../core/types.js';
import type { AgentFeature, FeatureInitContext, FeatureContext } from '../../core/feature.js';
import { DebugHub } from '../../core/debug-hub.js';

export interface UserInputFeatureConfig {
  /** 默认超时时间（毫秒），默认无限等待 */
  timeout?: number;
}

export class UserInputFeature implements AgentFeature {
  readonly name = 'user-input';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description = '允许 Agent 通过调试界面向用户发起输入请求并等待回复。';

  private defaultTimeout: number;
  private nextDraftInput = '';

  constructor(config: UserInputFeatureConfig = {}) {
    this.defaultTimeout = config.timeout ?? Infinity; // 无限等待
  }

  setNextDraftInput(input: string): void {
    this.nextDraftInput = input;
  }

  /**
   * 请求用户输入（核心方法）
   */
  async requestUserInput(prompt: string, timeout?: number): Promise<string> {
    const response = await this.requestUserInputEvent({ prompt }, timeout);
    if (response.kind !== 'text') {
      throw new Error(`Expected text input but received action '${response.actionId ?? 'unknown'}'`);
    }
    return response.text ?? '';
  }

  async requestUserInputEvent(
    request: UserInputRequest,
    timeout?: number,
  ): Promise<UserInputResponse> {
    // 直接获取 DebugHub 实例
    const debugHub = DebugHub.getInstance();

    // 获取当前注册的 agentId（从 DebugHub）
    const agentId = debugHub.getCurrentAgentId();
    const capabilities = debugHub.getCapabilities();

    if (!agentId) {
      throw new Error('Agent ID not available. UserInputFeature requires withViewer() to be called first.');
    }

    if (!capabilities.interactiveInput) {
      throw new Error(
        `Interactive input is not available for transport '${capabilities.transportMode}'. Current runtime URL: ${capabilities.runtimeUrl ?? 'n/a'}.`
      );
    }

    const response = await debugHub.requestUserInputEvent(
      agentId,
      {
        ...request,
        initialValue: request.initialValue ?? this.nextDraftInput,
      },
      timeout ?? this.defaultTimeout
    );
    this.nextDraftInput = '';
    return response;
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

  async getUserInputEvent(
    prompt: string = '请输入：',
    timeout?: number,
    actions?: UserInputAction[],
  ): Promise<UserInputResponse> {
    return this.requestUserInputEvent({
      prompt,
      placeholder: prompt,
      actions,
    }, timeout);
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
