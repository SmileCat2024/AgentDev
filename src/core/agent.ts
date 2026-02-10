/**
 * Agent - 组装所有组件
 * 提供简单的使用接口
 */

import type { AgentConfig, ContextMiddleware, Message } from './types.js';
import { ToolRegistry } from './tool.js';
import { Context } from './context.js';
import { runReactLoop } from './loop.js';
import { MessageViewer } from './viewer.js';

export class Agent {
  private llm: AgentConfig['llm'];
  private tools: ToolRegistry;
  private maxTurns: number;
  private systemMessage?: string;
  private middlewares: ContextMiddleware[] = [];
  private viewer?: MessageViewer;

  constructor(config: AgentConfig) {
    this.llm = config.llm;
    this.maxTurns = config.maxTurns ?? 10;
    this.systemMessage = config.systemMessage;
    this.tools = new ToolRegistry();

    // 注册工具
    if (config.tools) {
      for (const tool of config.tools) {
        this.tools.register(tool);
      }
    }
  }

  /**
   * 运行 Agent
   */
  async run(input: string): Promise<string> {
    const result = await runReactLoop({
      llm: this.llm,
      tools: this.tools.getAll(),
      input,
      maxTurns: this.maxTurns,
      systemMessage: this.systemMessage,
      onMessages: this.viewer ? (msgs) => this.viewer!.push(msgs) : undefined,
    });

    return result.content;
  }

  /**
   * 启用可视化查看器
   */
  async withViewer(port?: number): Promise<this> {
    this.viewer = new MessageViewer(port);
    await this.viewer.start();
    // 注册工具到viewer，用于渲染配置
    this.viewer.registerTools(this.tools.getAll());
    return this;
  }

  /**
   * 添加中间件
   */
  use(middleware: ContextMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  /**
   * 获取上下文（用于调试）
   */
  getContext(): Context {
    return new Context();
  }

  /**
   * 获取工具列表
   */
  getTools() {
    return this.tools;
  }
}
