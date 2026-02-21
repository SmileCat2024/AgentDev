/**
 * BasicAgent - 基础 Agent 类
 *
 * 封装了通用的工具集、LLM、Skills 目录和系统环境信息
 * 适用于大多数 Agent 场景
 *
 * 默认自动加载配置文件，开箱即用
 */

import { Agent } from '../../core/agent.js';
import type { AgentConfig, LLMClient, Tool } from '../../core/types.js';
import type { AgentConfigFile } from '../../core/config.js';
import type { MCPConfig } from '../../mcp/types.js';
import { loadConfig } from '../../core/config.js';
import { createOpenAILLM } from '../../llm/openai.js';
import { existsSync, readFileSync } from 'fs';
import { cwd, platform } from 'process';
import { join } from 'path';

// 导入系统工具（保留必要的非文件操作工具）
import {
  shellTool,
  webFetchTool,
  calculatorTool,
  invokeSkillTool,
  spawnAgentTool,
  listAgentsTool,
  sendToAgentTool,
  closeAgentTool,
} from '../../tools/system/index.js';

// 导入 opencode 文件工具（更强大的文件操作能力）
import {
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  lsTool,
} from '../../tools/opencode/index.js';

/**
 * 默认工具集
 * 使用 opencode 工具替代原 system 文件工具，提供更强的能力
 */
const DEFAULT_TOOLS: Tool[] = [
  // 文件操作工具（opencode 系列，能力更强）
  readTool,      // 高级读取：分页、二进制检测、行号、目录支持
  writeTool,     // 写入：带 diff 预览
  editTool,      // 编辑：9种智能匹配策略
  globTool,      // 文件搜索：glob 模式匹配
  grepTool,      // 内容搜索：基于 ripgrep
  lsTool,        // 目录列表：树形结构、自动忽略

  // 系统工具
  shellTool,     // Shell 命令执行
  webFetchTool,  // HTTP 请求
  calculatorTool,// 计算器
  invokeSkillTool, // 技能调用

  // 子代理管理工具
  spawnAgentTool,
  listAgentsTool,
  sendToAgentTool,
  closeAgentTool,
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
 * 所有参数都是可选的，默认会自动加载配置文件
 */
export interface BasicAgentConfig {
  /** LLM 客户端（可选，不传则自动加载配置创建） */
  llm?: LLMClient;
  /** 配置文件名（可选，默认 'default'） */
  configName?: string;
  /** Agent 显示名称（可选） */
  name?: string;
  /** 系统提示词（可选，后续可通过 setPrompt() 设置） */
  systemMessage?: string;
  /** MCP 配置（可选，将自动加载 .agentdev/mcps/{name}.json） */
  mcpServer?: string;
  /** MCP 运行时上下文（可选，如 GitHub Token） */
  mcpContext?: Record<string, unknown>;
  /** 自定义工具集（可选，默认使用系统工具集） */
  tools?: Tool[];
  /** Skills 目录（可选，默认使用 .agentdev/skills） */
  skillsDir?: string;
}

/**
 * 加载 MCP 配置
 */
function loadMCPConfig(serverName: string): MCPConfig | undefined {
  try {
    const configPath = join(cwd(), '.agentdev', 'mcps', `${serverName}.json`);
    if (!existsSync(configPath)) {
      return undefined;
    }
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/**
 * 基础 Agent 类
 *
 * 封装了通用工具集和系统环境信息，开箱即用
 * 构造函数不传任何参数时，会自动加载配置文件创建 LLM
 */
export class BasicAgent extends Agent {
  protected _systemContext: SystemContext;
  protected _mcpServer?: string;
  protected _mcpContext?: Record<string, unknown>;
  protected _config?: AgentConfigFile;

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

    // 构建 MCP 配置
    const mcpConfig = config.mcpServer ? loadMCPConfig(config.mcpServer) : undefined;

    // 构建完整的 Agent 配置
    const agentConfig: AgentConfig = {
      llm: config.llm!, // 如果是 undefined，会在 onInitiate 中延迟加载
      tools: config.tools ?? DEFAULT_TOOLS,
      maxTurns: Infinity,
      systemMessage: config.systemMessage,
      skillsDir: config.skillsDir ?? '.agentdev/skills',
      name: config.name,
      mcp: mcpConfig,
      mcpContext: config.mcpContext,
    };

    super(agentConfig);

    // 保存配置
    this._systemContext = systemContext;
    this._mcpServer = config.mcpServer;
    this._mcpContext = config.mcpContext;
    this.setSystemContext(systemContext);

    // 如果没有传入 llm，标记需要延迟加载
    if (!config.llm) {
      (this as any)._pendingConfigName = config.configName ?? 'default';
    }
  }

  /**
   * 获取系统环境信息
   */
  getSystemContext(): SystemContext {
    return this._systemContext ?? {};
  }

  /**
   * 获取 MCP 服务器配置
   */
  getMcpServer(): string | undefined {
    return this._mcpServer;
  }

  /**
   * 获取 MCP 上下文
   */
  getMcpContext(): Record<string, unknown> | undefined {
    return this._mcpContext;
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

    console.log(`[BasicAgent] 已加载配置: ${configName}, 模型: ${config.defaultModel.model}`);
  }
}
