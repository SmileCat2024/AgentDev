/**
 * BasicAgent - 基础 Agent 类
 *
 * 封装了通用的工具集、LLM、Skills 目录和系统环境信息
 * 适用于大多数 Agent 场景
 *
 * 默认自动加载配置文件，开箱即用
 */

import { Agent } from '../../core/agent.js';
import { MCPFeature, SkillFeature, SubAgentFeature, ShellFeature, OpencodeBasicFeature } from '../../features/index.js';
import type { AgentConfig, LLMClient, Tool } from '../../core/types.js';
import type { AgentConfigFile } from '../../core/config.js';
import { loadConfigSync } from '../../core/config.js';
import { createOpenAILLM } from '../../llm/openai.js';
import { existsSync } from 'fs';
import { cwd, platform } from 'process';
import { getDefaultMCPConfigDir } from '../../mcp/config.js';

// 导入系统工具（保留必要的非文件操作工具）
import {
  webFetchTool,
  calculatorTool,
} from '../../tools/system/index.js';

/**
 * 默认工具集
 * 注意：
 * - 文件操作工具（read/write/edit/glob/grep/ls）由 OpencodeBasicFeature 提供
 * - invokeSkillTool 由 SkillFeature 提供，不在默认工具集中
 * - 子代理工具由 SubAgentFeature 提供，不在默认工具集中
 */
const DEFAULT_TOOLS: Tool[] = [
  // 系统工具
  webFetchTool,  // HTTP 请求
  calculatorTool,// 计算器
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
 * BasicAgent 配置选项
 *
 * 所有参数都是可选的，默认会自动同步加载配置文件
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
  /** MCP 配置：传字符串时加载指定配置；传 false 时禁用自动加载；不传时若 .agentdev/mcps 存在则自动加载全部 */
  mcpServer?: string | false;
  /** MCP 运行时上下文（可选，如 GitHub Token） */
  mcpContext?: Record<string, unknown>;
  /** 自动扫描 MCP 时排除的 serverId 列表 */
  excludeMcpServers?: string[];
  /** 自定义工具集（可选，默认使用系统工具集） */
  tools?: Tool[];
  /** Skills 目录（可选，默认使用 .agentdev/skills） */
  skillsDir?: string;
}

/**
 * 基础 Agent 类
 *
 * 封装了通用工具集和系统环境信息，开箱即用
 * 构造函数不传任何参数时，会自动同步加载配置文件创建 LLM
 */
export class BasicAgent extends Agent {
  protected _systemContext: SystemContext;
  protected _mcpServer?: string | false;
  protected _mcpContext?: Record<string, unknown>;
  protected _config?: AgentConfigFile;
  protected _skillsDir?: string;
  protected _mcpFeature?: MCPFeature;

  /**
   * 构造函数
   *
   * @param config 基础配置（全部可选，不传则使用默认配置）
   */
  constructor(config: BasicAgentConfig = {}) {
    // 建立系统环境信息
    const systemContext: SystemContext = {
      SYSTEM_WORKING_DIR: cwd(),
      SYSTEM_IS_GIT_REPOSITORY: existsSync(cwd() + '/.git'),
      SYSTEM_PLATFORM: platform,
      SYSTEM_DATE: new Date().toISOString().split('T')[0], // YYYY-MM-DD
      SYSTEM_CURRENT_MODEL: 'unknown', // 稍后更新
    };

    // 准备 LLM：如果没传入，同步加载配置
    let llm = config.llm;
    let fileConfig: AgentConfigFile | undefined;
    if (!llm) {
      const configName = config.configName ?? 'default';
      fileConfig = loadConfigSync(configName);
      llm = createOpenAILLM(fileConfig);
      systemContext.SYSTEM_CURRENT_MODEL = fileConfig.defaultModel.model;
      console.log(`[BasicAgent] 已加载配置: ${configName}, 模型: ${fileConfig.defaultModel.model}`);
    }

    // 构建完整的 Agent 配置
    const agentConfig: AgentConfig = {
      llm: llm!,
      tools: config.tools ?? DEFAULT_TOOLS,
      maxTurns: Infinity,
      systemMessage: config.systemMessage,
      name: config.name,
    };

    super(agentConfig);

    // 保存配置（必须在 super() 之后）
    this._systemContext = systemContext;
    this._config = fileConfig;
    this._mcpServer = config.mcpServer;
    this._mcpContext = config.mcpContext;
    this._skillsDir = config.skillsDir;
    this.setSystemContext(systemContext);

    const hasDefaultMCPConfigs = existsSync(getDefaultMCPConfigDir());
    const shouldEnableMCP = config.mcpServer !== false && (typeof config.mcpServer === 'string' || hasDefaultMCPConfigs);
    if (shouldEnableMCP) {
      this._mcpFeature = typeof config.mcpServer === 'string'
        ? new MCPFeature(config.mcpServer)
        : new MCPFeature(undefined, { excludeServers: config.excludeMcpServers });
      if (config.mcpContext) {
        this._mcpFeature.setMCPContext(config.mcpContext);
      }
      this.use(this._mcpFeature);
    }

    // 注册 OpencodeBasicFeature（文件操作工具集）
    this.use(new OpencodeBasicFeature());

    // 注册 ShellFeature（Git Bash 命令执行）
    this.use(new ShellFeature());

    // 注册 SkillFeature（invokeSkill 工具和 skills 上下文注入）
    this.use(new SkillFeature(config.skillsDir));

    // 注册 SubAgentFeature（子代理工具和消息处理）
    this.use(new SubAgentFeature());

    // 预禁用不需要的子代理工具，确保首次快照与运行时一致
    this.getTools().disable('list_agents');
    this.getTools().disable('close_agent');
  }

  /**
   * 获取系统环境信息
   */
  getSystemContext(): SystemContext {
    return this._systemContext;
  }

  /**
   * 获取 MCP 服务器配置
   */
  getMcpServer(): string | false | undefined {
    return this._mcpServer;
  }

  /**
   * 获取 MCP 上下文
   */
  getMcpContext(): Record<string, unknown> | undefined {
    return this._mcpContext;
  }
}
