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
import type {
  Tool,
  UserInputAction,
  UserInputChoiceAnswer,
  UserInputQuestion,
  UserInputRequest,
  UserInputResponse,
} from '../../core/types.js';
import type { AgentFeature, FeatureInitContext, FeatureContext, PackageInfo } from '../../core/feature.js';
import { getPackageInfoFromSource } from '../../core/feature.js';
import { DebugHub } from '../../core/debug-hub.js';

export interface UserInputFeatureConfig {
  /** 默认超时时间（毫秒），默认无限等待 */
  timeout?: number;
}

interface ChoiceToolQuestionInput {
  id: string;
  question: string;
  options: Array<{
    id: string;
    label: string;
    description?: string;
    allowSupplement?: boolean;
    supplementRequired?: boolean;
    supplementLabel?: string;
    supplementPlaceholder?: string;
  }>;
  allowCustom?: boolean;
  customLabel?: string;
  customPlaceholder?: string;
}

const choiceToolRender = {
  call: {
    call: '<div class="bash-command">等待用户在选择弹窗中决策</div>',
    result: '',
  },
  result: {
    call: '',
    result: '<div class="bash-command">用户已完成选择</div>',
  },
};

export class UserInputFeature implements AgentFeature {
  readonly name = 'user-input';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description = '允许 Agent 通过调试界面向用户发起输入请求并等待回复。';

  private defaultTimeout: number;
  private nextDraftInput = '';

  /**
   * 缓存包信息
   */
  private _packageInfo: PackageInfo | null = null;

  /**
   * 获取包信息（统一打包方案）
   */
  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  /**
   * 获取模板名称列表（统一打包方案）
   * 注意：UserInputFeature 没有渲染模板
   */
  getTemplateNames(): string[] {
    return [];
  }

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

  async requestUserChoices(
    prompt: string,
    questions: UserInputQuestion[],
    timeout?: number,
  ): Promise<UserInputChoiceAnswer[]> {
    const normalizedQuestions = this.normalizeChoiceQuestions(questions);
    const response = await this.requestUserInputEvent({
      prompt,
      mode: 'choices',
      questions: normalizedQuestions,
    }, timeout);

    if (response.kind !== 'choices') {
      throw new Error(`Expected choice input but received '${response.kind}'`);
    }
    return response.choices ?? [];
  }

  private normalizeChoiceQuestions(questions: UserInputQuestion[]): UserInputQuestion[] {
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error('At least one choice question is required.');
    }

    return questions.map((question, index) => {
      const id = String(question.id || `question_${index + 1}`).trim();
      const text = String(question.question || '').trim();
      const options = Array.isArray(question.options) ? question.options : [];

      if (!text) {
        throw new Error(`Question ${index + 1} is missing a question prompt.`);
      }
      if (options.length < 1 || options.length > 4) {
        throw new Error(`Question ${index + 1} must provide 1 to 4 options.`);
      }

      return {
        id,
        question: text,
        options: options.map((option, optionIndex) => {
          const optionId = String(option.id || `option_${optionIndex + 1}`).trim();
          const label = String(option.label || '').trim();
          if (!label) {
            throw new Error(`Question ${index + 1}, option ${optionIndex + 1} is missing a label.`);
          }
          return {
            id: optionId,
            label,
            description: option.description ? String(option.description) : undefined,
            allowSupplement: Boolean(option.allowSupplement),
            supplementRequired: Boolean(option.supplementRequired),
            supplementLabel: option.supplementLabel ? String(option.supplementLabel) : undefined,
            supplementPlaceholder: option.supplementPlaceholder ? String(option.supplementPlaceholder) : undefined,
          };
        }),
        allowCustom: Boolean(question.allowCustom),
        customLabel: question.customLabel ? String(question.customLabel) : undefined,
        customPlaceholder: question.customPlaceholder ? String(question.customPlaceholder) : undefined,
      };
    });
  }

  getTools(): Tool[] {
    return [
      createTool({
        name: 'ask_user_choice',
        description: '向用户展示 1 道选择题，让用户点击或用键盘选择 1~4 个选项之一；可允许用户选择“其他”并输入自定义内容。',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: '选择卡片的总说明，简要说明为什么需要用户决策。'
            },
            question: {
              type: 'string',
              description: '要问用户的具体问题。'
            },
            options: {
              type: 'array',
              description: '1~4 个可选项。',
              minItems: 1,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: '稳定选项 ID。' },
                  label: { type: 'string', description: '选项显示文本。' },
                  description: { type: 'string', description: '可选的补充说明。' },
                  allowSupplement: { type: 'boolean', description: '是否允许用户在选择此选项后补充自由文本。' },
                  supplementRequired: { type: 'boolean', description: '补充文本是否为必填（仅 allowSupplement 为 true 时有效）。' },
                  supplementLabel: { type: 'string', description: '补充文本输入框的标签。' },
                  supplementPlaceholder: { type: 'string', description: '补充文本输入框的占位提示。' }
                },
                required: ['id', 'label']
              }
            },
            allowCustom: {
              type: 'boolean',
              description: '是否显示一个额外自定义选项，允许用户输入想说的话。'
            },
            customLabel: {
              type: 'string',
              description: '自定义选项的显示文本，例如“都不是，我想补充”。'
            },
            customPlaceholder: {
              type: 'string',
              description: '自定义输入框占位提示。'
            }
          },
          required: ['prompt', 'question', 'options']
        },
        execute: async ({ prompt, question, options, allowCustom, customLabel, customPlaceholder }) => {
          const choices = await this.requestUserChoices(prompt, [{
            id: 'question',
            question,
            options,
            allowCustom,
            customLabel,
            customPlaceholder,
          }]);
          return { choices, choice: choices[0] ?? null };
        },
        render: choiceToolRender,
      }),
      createTool({
        name: 'ask_user_choices',
        description: '一次向用户展示多道选择题。每题有 1~4 个选项，可各自允许自定义输入；用户完成一道后会直接进入下一道。',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: '选择卡片的总说明，简要说明为什么需要用户决策。'
            },
            questions: {
              type: 'array',
              description: '一组选择题。每道题必须有 1~4 个选项。',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: '稳定问题 ID。' },
                  question: { type: 'string', description: '问题文本。' },
                  options: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 4,
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', description: '稳定选项 ID。' },
                        label: { type: 'string', description: '选项显示文本。' },
                        description: { type: 'string', description: '可选的补充说明。' },
                        allowSupplement: { type: 'boolean', description: '是否允许用户在选择此选项后补充自由文本。' },
                        supplementRequired: { type: 'boolean', description: '补充文本是否为必填。' },
                        supplementLabel: { type: 'string', description: '补充文本输入框的标签。' },
                        supplementPlaceholder: { type: 'string', description: '补充文本输入框的占位提示。' }
                      },
                      required: ['id', 'label']
                    }
                  },
                  allowCustom: { type: 'boolean', description: '是否允许用户输入自定义内容。' },
                  customLabel: { type: 'string', description: '自定义选项显示文本。' },
                  customPlaceholder: { type: 'string', description: '自定义输入框占位提示。' }
                },
                required: ['id', 'question', 'options']
              }
            }
          },
          required: ['prompt', 'questions']
        },
        execute: async ({ prompt, questions }: { prompt: string; questions: ChoiceToolQuestionInput[] }) => {
          const choices = await this.requestUserChoices(prompt, questions);
          return { choices };
        },
        render: choiceToolRender,
      }),
    ];
  }

  async onInitiate(_ctx: FeatureInitContext): Promise<void> {
    // 不再需要保存 agentId，直接从 DebugHub 获取
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    // 清理资源（如有）
  }
}
