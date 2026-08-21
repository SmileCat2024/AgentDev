/**
 * ExplorerAgent - 代码探索者 Agent 纯基类
 *
 * 专注于代码库探索和理解的轻量级 Agent 基类。
 * 纯基类：零内置 Feature 装配，文件工具等能力由宿主通过 use() 显式
 * 挂载（装配权在宿主，ADR-0003 core 纪律）。只读定位通过装配层的
 * 工具裁剪实现，本类不再代劳。
 */

import { Agent } from '../../core/agent.js';
import type { AgentConfig, LLMClient } from '../../core/types.js';
import type { AgentConfigFile } from '../../core/config.js';
import { loadConfigSync } from '../../core/config.js';
import { createLLM } from '../../llm/index.js';
import { existsSync } from 'fs';
import { cwd, platform } from 'process';
import { TemplateComposer } from '../../template/composer.js';

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
  /** Shell 环境描述 */
  SYSTEM_SHELL_ENV: string;
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
 * 所有参数都是可选的，默认会自动同步加载配置文件。
 * 需要工具或上下文注入时，构造后通过 use() 显式挂载 Feature。
 */
export interface ExplorerAgentConfig {
  /** LLM 客户端（可选，不传则自动同步加载配置创建） */
  llm?: LLMClient;
  /** 配置文件名（可选，默认 'default'） */
  configName?: string;
  /** Agent 显示名称（可选） */
  name?: string;
  /** 系统提示词（可选，默认使用 explorer.md） */
  systemMessage?: string;
}

/**
 * 代码探索者 Agent
 *
 * 轻量级代码探索 Agent 基类，专注于：
 * - 代码库结构分析
 * - 代码审查和理解
 * - 文档生成
 * - 依赖关系梳理
 *
 * 构造函数不传任何参数时，会自动同步加载配置文件创建 LLM
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
      SYSTEM_SHELL_ENV: platform === 'win32' ? 'Git bash' : (platform === 'darwin' ? 'Bash (macOS)' : 'Bash'),
      SYSTEM_DATE: new Date().toISOString().split('T')[0], // YYYY-MM-DD
      SYSTEM_CURRENT_MODEL: 'unknown', // 稍后更新
    };

    // 准备 LLM：如果没传入，同步加载配置
    let llm = config.llm;
    let fileConfig: AgentConfigFile | undefined;
    if (!llm) {
      const configName = config.configName ?? 'default';
      fileConfig = loadConfigSync(configName);
      llm = createLLM(fileConfig);
      systemContext.SYSTEM_CURRENT_MODEL = fileConfig.defaultModel.model;
      console.log(`[ExplorerAgent] 已加载配置: ${configName}, 模型: ${fileConfig.defaultModel.model}`);
    }

    // 构建完整的 Agent 配置
    const agentConfig: AgentConfig = {
      llm: llm!,
      tools: [],              // 工具由宿主装配
      maxTurns: Infinity,     // 无限交互次数
      systemMessage: config.systemMessage,
      name: config.name,
    };

    super(agentConfig);

    // 保存配置（必须在 super() 之后）
    this._systemContext = systemContext;
    this._config = fileConfig;
    this.setSystemContext(systemContext);
  }

  /**
   * Agent 初始化钩子
   * 默认系统提示词（explorer.md + 系统环境）
   */
  protected override async onInitiate(): Promise<void> {
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
    return this._systemContext;
  }
}
