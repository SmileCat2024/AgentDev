/**
 * BasicAgent - 基础 Agent 纯基类
 *
 * 只负责：系统环境信息上下文、LLM 自动加载（可选）、AgentConfig 组装。
 * 不内置任何 Feature 装配——文件工具、skills、MCP、子代理等能力
 * 一律由宿主通过 use() 显式挂载（装配权在宿主，ADR-0003 core 纪律）。
 *
 * 默认自动加载配置文件，开箱即用
 */

import { Agent } from '../../core/agent.js';
import type { AgentConfig, LLMClient, Tool } from '../../core/types.js';
import type { AgentConfigFile } from '../../core/config.js';
import { loadConfigSync } from '../../core/config.js';
import { createLLM } from '../../llm/index.js';
import { existsSync } from 'fs';
import { cwd, platform } from 'process';
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
 * BasicAgent 配置选项
 *
 * 所有参数都是可选的，默认会自动同步加载配置文件。
 * 需要工具或上下文注入时，构造后通过 use() 显式挂载 Feature。
 */
export interface BasicAgentConfig {
  /** LLM 客户端（可选，不传则自动同步加载配置创建） */
  llm?: LLMClient;
  /** 配置文件名（可选，默认 'default'） */
  configName?: string;
  /** Agent 显示名称（可选） */
  name?: string;
  /** 系统提示词（可选，后续可通过 setPrompt() 设置） */
  systemMessage?: string;
  /** 自定义工具集（可选，默认为空） */
  tools?: Tool[];
  /** Feature 特定配置（可选） */
  features?: AgentConfig['features'];
  /** 调试器和模板解析使用的项目根目录 */
  projectRoot?: string;
  /** 工具默认操作的工作目录 */
  workspaceDir?: string;
}

/**
 * 基础 Agent 类
 *
 * 纯基类：集成系统环境信息与 LLM 自动加载，零内置 Feature 装配。
 * 构造函数不传任何参数时，会自动同步加载配置文件创建 LLM
 */
export class BasicAgent extends Agent {
  protected _systemContext: SystemContext;
  protected _config?: AgentConfigFile;

  /**
   * 构造函数
   *
   * @param config 基础配置（全部可选，不传则使用默认配置）
   */
  constructor(config: BasicAgentConfig = {}) {
    const workspaceDir = config.workspaceDir ?? cwd();
    // 建立系统环境信息
    const systemContext: SystemContext = {
      SYSTEM_WORKING_DIR: workspaceDir,
      SYSTEM_IS_GIT_REPOSITORY: existsSync(workspaceDir + '/.git'),
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
      console.log(`[BasicAgent] 已加载配置: ${configName}, 模型: ${fileConfig.defaultModel.model}`);
    }

    // 构建完整的 Agent 配置
    const agentConfig: AgentConfig = {
      llm: llm!,
      tools: config.tools ?? [],
      maxTurns: Infinity,
      systemMessage: config.systemMessage,
      name: config.name,
      projectRoot: config.projectRoot,
      workspaceDir,
      features: config.features,
    };

    super(agentConfig);

    // 保存配置（必须在 super() 之后）
    this._systemContext = systemContext;
    this._config = fileConfig;
    this.setSystemContext(systemContext);
  }

  /**
   * 获取系统环境信息
   */
  getSystemContext(): SystemContext {
    return this._systemContext;
  }
}
