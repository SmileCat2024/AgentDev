/**
 * ExplorerAgent - 代码探索者 Agent
 *
 * 专注于代码库探索和理解的轻量级 Agent
 * 仅配备 read、list、bash 三个核心工具
 * 适用于代码审查、结构分析、文档生成等场景
 */

import { Agent } from '../../core/agent.js';
import type { AgentConfig, LLMClient, Tool } from '../../core/types.js';
import type { AgentConfigFile } from '../../core/config.js';
import { loadConfig } from '../../core/config.js';
import { createOpenAILLM } from '../../llm/openai.js';
import { existsSync, readFileSync } from 'fs';
import { cwd, platform } from 'process';
import { join } from 'path';
import { TemplateComposer } from '../../template/composer.js';

// 导入系统工具（探索工具 + 子代理工具）
import {
  readFileTool,
  listDirTool,
  shellTool,
  spawnAgentTool,
  listAgentsTool,
  sendToAgentTool,
  closeAgentTool,
} from '../../tools/system/index.js';

/**
 * ExplorerAgent 专用工具集（探索工具 + 子代理管理）
 */
const EXPLORER_TOOLS: Tool[] = [
  readFileTool,     // 读取文件
  listDirTool,      // 列出目录
  shellTool,        // 执行命令
];

/**
 * 系统环境信息上下文
 */
export interface SystemContext {
  /** 当前工作目录 */
  SYSTEM_WORKING_DIR: string;
  /** 是否是 Git 仓库 */
  SYSTEM_IS_GIT_REPOSITORY: boolean;
  /** 操作系统平台 */
  SYSTEM_PLATFORM: NodeJS.Platform;
  /** 当前日期 (YYYY-MM-DD) */
  SYSTEM_DATE: string;
  /** 当前使用的模型名称 */
  SYSTEM_CURRENT_MODEL: string;
  /** 索引签名，允许作为 PlaceholderContext 使用 */
  [key: string]: any;
}

/**
 * ExplorerAgent 配置选项
 *
 * 所有参数都是可选的，默认会自动加载配置文件
 */
export interface ExplorerAgentConfig {
  /** LLM 客户端（可选，不传则自动加载配置创建） */
  llm?: LLMClient;
  /** 配置文件名（可选，默认 'default'） */
  configName?: string;
  /** Agent 显示名称（可选） */
  name?: string;
  /** 系统提示词（可选，默认使用 explorer.md） */
  systemMessage?: string;
  /** Skills 目录（可选，默认使用 .agentdev/skills） */
  skillsDir?: string;
}

/**
 * 代码探索者 Agent
 *
 * 轻量级代码探索 Agent，专注于：
 * - 代码库结构分析
 * - 代码审查和理解
 * - 文档生成
 * - 依赖关系梳理
 *
 * 构造函数不传任何参数时，会自动加载配置文件创建 LLM
 */
export class ExplorerAgent extends Agent {
  protected _systemContext: SystemContext;
  protected _config?: AgentConfigFile;

  /**
   * 构造函数
   *
   * @param config 探索者配置（全部可选，不传则使用默认配置）
   */
  constructor(config: ExplorerAgentConfig = {}) {
    // 建立系统环境信息
    const systemContext: SystemContext = {
      SYSTEM_WORKING_DIR: cwd(),
      SYSTEM_IS_GIT_REPOSITORY: existsSync(cwd() + '/.git'),
      SYSTEM_PLATFORM: platform,
      SYSTEM_DATE: new Date().toISOString().split('T')[0], // YYYY-MM-DD
      SYSTEM_CURRENT_MODEL: 'unknown', // 稍后更新
    };

    // 构建完整的 Agent 配置
    const agentConfig: AgentConfig = {
      llm: config.llm!, // 如果是 undefined，会在 onInitiate 中延迟加载
      tools: EXPLORER_TOOLS,  // 固定使用探索工具集
      maxTurns: Infinity,      // 无限交互次数
      systemMessage: config.systemMessage,
      skillsDir: config.skillsDir ?? '.agentdev/skills',
      name: config.name,
    };

    super(agentConfig);

    // 保存配置
    this._systemContext = systemContext;
    this.setSystemContext(systemContext);

    // 如果没有传入 llm，标记需要延迟加载
    if (!config.llm) {
      (this as any)._pendingConfigName = config.configName ?? 'default';
    }
  }

  /**
   * Agent 初始化钩子
   * 配置系统提示词
   */
  protected override async onInitiate(): Promise<void> {
    // 延迟加载 LLM（如果需要）
    await this.loadLLMIfNeeded();

    // 配置系统提示词
    if (!this.systemMessage) {
      this.setSystemPrompt(new TemplateComposer()
        .add({ file: '.agentdev/prompts/explorer.md' })
        .add('\n\n## 系统环境\n\n')
        .add('- 工作目录: `{{SYSTEM_WORKING_DIR}}`\n')
        .add('- Git 仓库: {{SYSTEM_IS_GIT_REPOSITORY}}\n')
        .add('- 操作系统: {{SYSTEM_PLATFORM}}\n')
        .add('- bash版本：PowerShell 5.1\n')
        .add('- 当前日期: {{SYSTEM_DATE}}\n')
      );
    }
  }

  /**
   * 获取系统环境信息
   */
  getSystemContext(): SystemContext {
    return this._systemContext ?? {};
  }

  /**
   * 延迟加载 LLM（在 onInitiate 中调用）
   */
  protected async loadLLMIfNeeded(): Promise<void> {
    // 如果已经有 llm，跳过
    if (this.llm) {
      return;
    }

    const configName = (this as any)._pendingConfigName ?? 'default';
    const config = await loadConfig(configName);
    this._config = config;

    // 创建 LLM
    this.llm = createOpenAILLM(config);

    // 更新系统上下文中的模型名称
    this._systemContext.SYSTEM_CURRENT_MODEL = config.defaultModel.model;
    this.setSystemContext(this._systemContext);

    console.log(`[ExplorerAgent] 已加载配置: ${configName}, 模型: ${config.defaultModel.model}`);
  }
}
