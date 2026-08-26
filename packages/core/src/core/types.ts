/**
 * 基础类型定义
 * 所有类型集中在这里，简单直观
 */

// continuation 类型仅作引用，纯类型 import 无循环依赖
import type { CallContinuationRequest } from './continuation.js';

// ========== 通知系统类型 ==========

/**
 * 通知分类
 * - state: 覆盖式更新（如 LLM 字符计数）
 * - event: 追加式记录（如工具开始/完成）
 */
export type NotificationCategory = 'state' | 'event';

/**
 * LLM 生成阶段
 */
export type LLMPhase = 'thinking' | 'content' | 'tool_calling';

/**
 * 通知基础接口
 */
export interface Notification {
  type: string;
  category: NotificationCategory;
  timestamp: number;
  data: unknown;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export type DebugLogDeliveryReason =
  | 'hub'
  | 'hub-unavailable'
  | 'no-agent-context';

export interface DebugLogDelivery {
  hub: boolean;
  console: boolean;
  reason: DebugLogDeliveryReason;
}

export interface LogContextRef {
  agentId?: string;
  agentName?: string;
  parentAgentId?: string;
  callIndex?: number;
  step?: number;
  toolName?: string;
  toolCallId?: string;
  feature?: string;
  lifecycle?: string;
  hookMethod?: string;
  hookKind?: 'forward' | 'observe' | 'guard' | 'transform';
  sourceFile?: string;
  sourceLine?: number;
  tags?: string[];
  [key: string]: unknown;
}

export interface DebugLogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  message: string;
  namespace: string;
  context: LogContextRef;
  data?: unknown;
  delivery: DebugLogDelivery;
}

/**
 * LLM 字符计数通知数据
 */
export interface LLMCharCountData {
  charCount: number;
  phase: LLMPhase;
  thinkingChars?: number;
  contentChars?: number;
  toolCallCount?: number;
  /** 流式期间已检测到的工具名称（tool_calling 阶段可用） */
  streamToolNames?: string[];
}

/**
 * LLM 完成通知数据
 */
export interface LLMCompleteData {
  totalChars: number;
}

export interface ToolStartData {
  toolName: string;
}

export type RuntimeStage =
  | 'idle'
  | 'llm_thinking'
  | 'llm_content'
  | 'llm_tool_call_building'
  | 'awaiting_runtime'
  | 'tool_executing'
  | 'retry_waiting'
  | 'retry_requesting'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * 工具终止原因（ticket 023 / ADR-0005）
 *
 * - 'timeout'：框架统一超时计时触发（Tool 声明 timeout 后生效）
 * - 'user'：外部用户中断（Agent.interrupt() 触发的 abort signal）
 */
export type ToolTerminationReason = 'timeout' | 'user';

export interface AgentRuntimeStateSnapshot {
  stage: RuntimeStage;
  callActive: boolean;
  charCount: number;
  thinkingChars: number;
  contentChars: number;
  toolCallCount: number;
  activeToolNames: string[];
  activeToolCount: number;
  /** LLM 流式期间检测到的工具名称（仅 llm_tool_call_building 阶段有值） */
  streamToolNames?: string[];
  callStartedAt?: number;
  stageStartedAt?: number;
  retryAttempt?: number;
  maxRetries?: number;
  nextRetryDelayMs?: number;
  lastErrorType?: string | null;
  lastErrorMessage?: string | null;
  /** 最近一次已结束 Call 的结构化终态。 */
  lastOutcome?: import('./lifecycle.js').CallOutcome | null;
  updatedAt: number;
}

/**
 * 工具执行上下文
 *
 * 由框架在执行工具时注入。Feature 通过 {@link AgentFeature.getContextInjectors}
 * 可以扩展额外字段。
 */
export interface ToolExecutionContext {
  /** 中断信号，用于取消工具执行（外部用户中断与框架超时合并后的 signal） */
  signal?: AbortSignal;
  /** 当前工具调用的 LLM 生成 call.id（tool.progress 等进度信号配对用） */
  callId?: string;
  /**
   * 查询当前工具执行是否已被终止及终止原因（ticket 023）。
   *
   * 返回 null 表示尚未终止；工具可据此在结果中填写模型可读的终止元数据。
   * reason 不挂在 AbortSignal 上（signal 保持标准形状），统一经此函数查询。
   */
  termination?: () => ToolTerminationReason | null;
  /** 当前终止 settle 的绝对截止时间（epoch ms）；工具用于把内部 drain 纳入同一预算。 */
  terminationDeadline?: () => number | null;
  /** 本次调用生效的超时（毫秒，含 args 覆盖后的 clamp 结果）；仅声明 timeout 的工具注入（ticket 025 进度显示用） */
  timeoutMs?: number;
  /** 注册 continuation request（供 checkpoint/rollback 等控制流工具使用） */
  registerContinuationRequest?: (request: CallContinuationRequest) => void;
  /** Feature 通过 contextInjectors 注入的自定义属性 */
  [key: string]: unknown;
}

/**
 * 工具执行返回值类型
 *
 * 工具可以返回纯文本或结构化对象。框架会自动序列化非 string 返回值。
 */
export type ToolResultValue = string | Record<string, unknown>;

/**
 * 工具定义
 */
export interface Tool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  /**
   * 执行工具
   *
   * @param args 工具参数（来自 LLM 的 JSON 解析结果）
   * @param context 执行上下文，包含框架注入的 signal、registerContinuationRequest，
   *   以及各 Feature 通过 contextInjectors 注入的自定义属性
   */
  execute: (args: Record<string, unknown>, context?: ToolExecutionContext) => Promise<ToolResultValue>;
  /** 可选：渲染配置 */
  render?: ToolRenderConfig;
  /**
   * 工具执行模式
   * - 'normal'（默认）：普通工具，可与其他工具在同一次 assistant turn 中并行调用
   * - 'exclusive'：独占工具，必须是 assistant turn 中唯一的工具调用
   *
   * exclusive 工具适用于控制流工具（如 checkpoint、rollback），
   * 它们不应与其他工具产生副作用交织。
   */
  executionMode?: 'normal' | 'exclusive';
  /**
   * 工具是否可并行执行。
   *
   * - true: 该工具可以与同批次中其他 parallelizable 工具并发执行
   * - false/undefined: 串行执行（默认，向后兼容）
   *
   * 约束：
   * - exclusive 工具忽略此属性（exclusive 总是独占批次）
   * - 标记为 parallelizable 的工具应是无副作用的只读操作，
   *   或其副作用不会与同批次其他工具冲突
   */
  parallelizable?: boolean;
  /**
   * 超时契约声明（ticket 023 / ADR-0005）。
   *
   * 声明后由框架执行器统一计时：超时触发合并 AbortSignal（reason=timeout），
   * 并给工具一个 settle 窗口优雅收尾；未声明的工具不受框架超时管辖，行为不变。
   *
   * - defaultMs: 默认超时（模型未通过 fromArg 参数覆盖时生效）
   * - maxMs: 生效超时的硬上限，任何来源的超时值都会被 clamp 到 [1, maxMs]
   * - fromArg: 可选参数名；声明后生效超时取 args[fromArg]（数字），再 clamp
   */
  timeout?: {
    defaultMs: number;
    maxMs: number;
    fromArg?: string;
  };
}

/**
 * 工具完成通知数据
 */
export interface ToolCompleteData {
  toolName: string;
  success: boolean;
  duration: number;
}

/**
 * 通知状态响应（GET /api/agents/:id/notification）
 */
export interface NotificationStateResponse {
  state: Notification | null;
  event: Notification | null;
  runtime: AgentRuntimeStateSnapshot;
  callActive: boolean;
  hasNewEvents: boolean;
}

export interface AgentLogsResponse {
  scope: 'current' | 'all';
  selectedAgentId: string | null;
  total: number;
  logs: DebugLogEntry[];
  truncation?: {
    truncated: boolean;
    appliedLimit?: number;
    returnedCount: number;
    availableCount: number;
    nextOffset?: number;
    reason?: string;
    guidance?: string;
  };
  collectionPolicy: {
    hubConnected: boolean;
    includesOnlyHubDeliveredLogs: boolean;
    fallbackBehavior: string;
  };
}

/**
 * Agent 连接状态响应（GET /api/agents/:id/connection）
 */
export interface AgentConnectionResponse {
  connected: boolean;
}

// ========== 消息类型 ==========

// 消息角色（支持子代理 ID 作为消息来源）
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | string;

/**
 * 图片输入（多模态支持）
 *
 * 支持两种数据来源：
 * - `path`：图片已落盘到本地文件，编译 LLM 请求时按需读取为 base64（推荐）
 * - `base64`：内联 base64 数据（向后兼容旧会话）
 *
 * 优先使用 `path`；`base64` 仅作为旧会话兼容或无法落盘时的回退。
 * - 视觉模式（vision: true）：从 path 或 base64 读取图片数据传给 LLM API
 * - 非视觉模式（vision: false）：source 用于生成文字占位符
 */
export interface ImageInput {
  /** 本地文件绝对路径（推荐方式，避免 session 膨胀） */
  path?: string;
  /** Base64 编码的图片数据（不含 data URI 前缀），向后兼容 */
  base64?: string;
  /** MIME 类型，如 'image/png'、'image/jpeg' */
  mediaType?: string;
  /** 来源描述或原始文件名（用于非视觉模式的文字占位符显示） */
  source?: string;
}

// 消息结构
export interface Message {
  role: MessageRole;
  content: string;
  turn?: number;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  reasoning?: string; // 思考内容（GLM-4.7等模型的扩展字段）
  thinkingBlocks?: ThinkingBlock[];
  /** 图片附件（user 消息：用户输入的图片；tool 消息：工具返回的图片），多模态输入 */
  images?: ImageInput[];
  /**
   * 前端展示数据（仅 tool 消息）。
   *
   * 当工具使用 withDisplay() 分离返回时，display 携带富数据（如 diff），
   * 仅供前端渲染，不注入 LLM 上下文。LLM 只看到 content 中的精简文本。
   */
  display?: unknown;
  /**
   * 消息来源标记（仅 system 消息使用）。
   *
   * - undefined：agent 自身的系统提示词（由 templateResolver 生成），
   *   Anthropic provider 将其放入顶层 system 参数。
   * - 有值（如 'handoff-seed'、'partial-compact'）：Feature 注入的 system 消息，
   *   Anthropic provider 将其包裹为 <reminder> 嵌入最近的 user turn，
   *   而非混入顶层 system 参数。
   */
  source?: string;
  /**
   * 消息语义标签（所有 role 通用）。
   *
   * 与 source 的区别：
   * - source 控制 LLM 编译层行为（顶层 system vs reminder）
   * - tag 控制上下文管理层行为（trim/compact 时的保留策略）
   *
   * undefined = 无标签，向后兼容，行为与当前完全一致。
   */
  tag?: string;
  /**
   * LLM 用量信息（仅 assistant 消息有值）。
   *
   * 由 LLM provider 在生成响应时返回，表示生成此消息时的上下文 token 开销。
   * inputTokens 是发送给 LLM 的完整上下文大小（包含所有历史消息），
   * 不是单条消息的 token 数。
   */
  usage?: MessageUsage;
  /**
   * 执行终态元数据（仅 assistant 消息有值）。
   *
   * 框架在写入错误/截断等执行结果消息时盖戳。展示端（Web UI / 查看器）
   * 应依据此字段渲染终态样式，而不是解析 content 文本前缀；该字段随
   * 会话快照持久化，重渲染后保持稳定。
   */
  execution?: MessageExecutionMeta;
}

/**
 * 消息级执行终态摘要（Message.execution）
 *
 * CallOutcome 的可序列化子集；不重复 response/steps 等会话级信息。
 */
export interface MessageExecutionMeta {
  status: import('./lifecycle.js').ExecutionStatus;
  reason: import('./lifecycle.js').ExecutionReason;
  error?: import('./lifecycle.js').ExecutionError;
}

/**
 * 消息级用量记录（盖戳在 assistant 消息上）
 */
export interface MessageUsage {
  /** 生成此消息时，发送给 LLM 的总输入 token（即当时的完整上下文大小） */
  inputTokens: number;
  /** LLM 生成的输出 token */
  outputTokens: number;
}

export interface ThinkingBlock {
  signature: string;
  thinking: string;
}

// 工具调用
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

// LLM 响应
export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  reasoning?: string; // 思考内容（GLM-4.7等模型的扩展字段）
  thinkingBlocks?: ThinkingBlock[];
  /** 用量统计（可选） */
  usage?: UsageInfo;
  /** 停止原因，由 LLM API 返回（如 end_turn, tool_use, stop 等） */
  stopReason?: string | null;
}

// ============= 渲染模板类型 =============
/**
 * 渲染模板项
 * 可以是字符串模板或函数模板
 */
export type RenderTemplateItem =
  | string                    // 字符串模板，使用 {{key}} 插值
  | RenderTemplateFn;         // 函数模板，处理复杂逻辑

/**
 * 渲染模板函数类型
 */
export type RenderTemplateFn = (data: Record<string, any>, success?: boolean) => string;

/**
 * 内联渲染模板
 * 直接定义在工具中的渲染模板（无需引用预设模板）
 */
export interface InlineRenderTemplate {
  call: RenderTemplateItem;
  result: RenderTemplateItem;
}

// 工具渲染配置
export interface ToolRenderConfig {
  /** 调用时的渲染模板（字符串引用或内联模板） */
  call?: string | InlineRenderTemplate;
  /** 结果时的渲染模板（字符串引用或内联模板） */
  result?: string | InlineRenderTemplate;
}

// LLM 接口 - 所有 LLM 适配器都需要实现这个
export interface LLMClient {
  chat(messages: Message[], tools: Tool[], options?: LLMChatOptions): Promise<LLMResponse>;
  /** 可选：返回当前 LLM 实例使用的模型名（用于调试显示） */
  readonly modelName?: string;
}

// LLM 调用选项
export interface LLMChatOptions {
  /** 允许中断正在进行的 LLM 调用 */
  signal?: AbortSignal;
  /** 请求非流式响应（适用于一次性摘要、标题生成等场景） */
  noStream?: boolean;
}

/**
 * 可热更新的模型元数据（与 LLMClient 实例解耦）
 *
 * 用于 Agent.setLLM() 时传递模型上下文信息，
 * 供 Feature（如 ContextGuard）根据新模型的 contextLength 调整行为。
 */
export interface LLMMeta {
  modelName?: string;
  contextLength?: number | null;
  compressRatio?: number;
  presetName?: string;
  thinkingEffort?: string | null;
  /** 模型协议（'anthropic' | 'openai' 等），由 resolver 提供时携带，供档位切换等消费方推断协议 */
  provider?: string;
  /** 本次切换的发起方标记：'boot' | 'user' | 'feature:<name>' 等，供让位策略区分用户手动切换与 Feature 切换 */
  source?: string;
}

/**
 * resolver 解析产物：成品 LLM 客户端 + 对齐 LLMMeta 的元数据。
 * 资产（apiKey / OAuth token / 配置文件）由注入方持有，永不进入本结构。
 */
export interface ResolvedModelPreset {
  llm: AgentConfig['llm'];
  meta: LLMMeta;
}

/**
 * 模型 preset 解析服务契约（应用层注入，core 不提供实现）。
 *
 * 框架只编排"怎么换"（resolve → setLLM → 贴标 → 通知）；
 * "有哪些 preset、凭证在哪、客户端怎么造"归应用层。每次调用都应现读
 * 配置源（不缓存快照），调用方可安全地以任意频率重复调用。
 */
export interface ModelPresetResolver {
  /**
   * @param presetName preset 名（应用层命名空间，如 Claw 的 presets.json 条目名）
   * @param overrides 运行时覆盖；thinkingEffort 为 null 表示清除为厂商默认。
   * @returns 解析失败（名字不存在 / 凭证缺失）返回 null，不抛错
   */
  resolve(presetName: string, overrides?: { thinkingEffort?: string | null }): ResolvedModelPreset | null;
}

// 占位符上下文类型
import type { PlaceholderContext, TemplateSource } from '../template/types.js';

// MCP 类型导入（契约类型，协议中性；实现在 @agentdevjs/mcp）
import type { MCPConfig } from './mcp-contract.js';
import type { UsageInfo, UsageStatsSnapshot } from './usage.js';

// UsageInfo 权威定义位于 usage.ts；此处 re-export 保持 types.js 的既有导入路径
export type { UsageInfo };

// Agent 配置
export interface AgentConfig {
  llm: LLMClient;
  tools?: Tool[];
  maxTurns?: number;
  systemMessage?: string | TemplateSource;
  name?: string;  // Agent 显示名称（用于调试）
  projectRoot?: string;
  workspaceDir?: string;
  /**
   * 模型 preset 解析服务（可选注入）。
   * 注入后 setModel / setThinkingEffort 可用；资产留在注入方，agent 只拿成品客户端。
   */
  modelResolver?: ModelPresetResolver;

  // ========== Feature 系统 ==========
  /**
   * Feature 配置
   *
   * 新的声明式 Feature 注册方式
   */
  features?: {
    /** 启用的 Feature 列表 */
    enabled?: string[];
    /** Feature 特定配置 */
    [key: string]: unknown;
  };
}

// 上下文中间件 - 用于处理消息数组
export type ContextMiddleware = (messages: Message[]) => Message[];

// ============= 多 Agent 调试支持 =============

/**
 * Agent 注册信息（Hub 端）
 */
export interface AgentInfo {
  id: string;           // 唯一标识，如 "agent-1"
  name: string;         // 显示名称
  registeredAt: number; // 注册时间戳
  projectRoot?: string;
}

/**
 * 工具元数据（用于前端渲染）
 */
export interface ToolMetadata {
  name: string;
  description: string;
  render: {
    call: string | InlineRenderTemplate;   // 模板名称或内联模板
    result: string | InlineRenderTemplate; // 模板名称或内联模板
    // 内联模板的可选直接存储（用于前端特殊标记）
    inlineCall?: InlineRenderTemplate;
    inlineResult?: InlineRenderTemplate;
  };
}

export interface HookSourceLocation {
  file?: string;
  line?: number;
  column?: number;
  display: string;
}

export interface HookEntryMetadata {
  order: number;
  featureName: string;
  methodName: string;
  lifecycle: string;
  /** 三原语（observe / guard / transform），由静态声明或装饰器路径推导 */
  kind: 'observe' | 'guard' | 'transform';
  /** guard 角色（policy 先于 advisor 执行）。仅 kind='guard' 条目存在。 */
  role?: 'policy' | 'advisor';
  source?: HookSourceLocation;
  description?: string;
  /** 是否启用。false 表示被运行时禁用。缺省视为 true（向后兼容）。 */
  enabled?: boolean;
}

export interface HookLifecycleSnapshot {
  lifecycle: string;
  /** 生命周期级三原语汇总：桶内有 guard → guard，有 transform → transform，否则 observe */
  kind: 'observe' | 'guard' | 'transform';
  entries: HookEntryMetadata[];
}

export interface FeatureInspectorSnapshot {
  name: string;
  enabled: boolean;
  status: 'enabled' | 'disabled' | 'removed' | 'partial';
  hookCount: number;
  toolCount: number;
  enabledToolCount: number;
  source?: string;
  description?: string;
  tools: Array<{
    name: string;
    description: string;
    state: 'enabled' | 'disabled' | 'removed' | 'superseded';
    enabled?: boolean;
    renderCall?: string;
    renderResult?: string;
    parameters?: Record<string, unknown>;
  }>;
}

export interface HookInspectorSnapshot {
  lifecycleOrder: string[];
  features: FeatureInspectorSnapshot[];
  hooks: HookLifecycleSnapshot[];
  standaloneTools?: Array<{
    name: string;
    description: string;
    state: 'enabled' | 'disabled' | 'removed' | 'superseded';
    enabled?: boolean;
    source?: string;
    renderCall?: string;
    renderResult?: string;
    parameters?: Record<string, unknown>;
  }>;
}

export interface AgentContextMetrics {
  messageCount: number;
  charCount: number;
  toolCallCount: number;
  turnCount: number;
}

export interface AgentOverviewSnapshot {
  updatedAt: number;
  context: AgentContextMetrics;
  usageStats: UsageStatsSnapshot;
  runtime?: AgentRuntimeStateSnapshot;
  /** 可选：当前使用的模型名（由 agent 实例注入） */
  modelName?: string;
  /** 可选：当前使用的预设名（由 agent 实例注入，用于 UI dropdown 高亮） */
  presetName?: string;
  /** 可选：当前 LLM 实例的思考强度（由 agent 实例注入，用于 UI 状态同步） */
  thinkingEffort?: string | null;
  /** 可选：当前模型的上下文窗口长度（由 agent 实例注入，用于 UI 用量条实时同步） */
  contextLength?: number;
  /** 可选：当前模型的压缩阈值百分比（由 agent 实例注入，用于 UI 用量条实时同步） */
  compressRatio?: number;
}

export interface TodoTaskSnapshot {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface TodoPlanSummary {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  cancelled: number;
}

export interface TodoPlanSnapshot {
  feature: 'todo';
  updatedAt: number;
  counter: number;
  tasks: TodoTaskSnapshot[];
  summary: TodoPlanSummary;
  /** 中断目标 task ID（由 ControlledTodoFeature 扩展，null = 无中断目标） */
  interruptTargetId?: string | null;
  /** 任务未完强制继续开关状态（由 ControlledTodoFeature 扩展，null = 未上报） */
  forceContinue?: {
    enabled: boolean;
    consecutive: number;
    max: number;
  } | null;
}

/**
 * Agent 会话数据（Worker 端）
 */
export interface AgentSession {
  id: string;
  name: string;
  messages: Message[];
  tools: ToolMetadata[];
  createdAt: number;
  lastActive: number;
  // 项目根目录（用于定位模板文件）
  projectRoot?: string;
  // 通知系统扩展
  currentState: Notification | null;
  // call 运行状态（独立于 currentState，不受 state 覆盖影响）
  callActive?: boolean;
  runtimeState?: AgentRuntimeStateSnapshot;
  events: Notification[];
  lastEventCount: number;
  logs: DebugLogEntry[];
  // 所属 UDS 客户端连接 ID（用于多进程输入响应路由）
  clientId?: string;
  // 内部：上次最后一条消息的签名（用于推送去重）
  _lastMessageSig?: string;
  hookInspector?: HookInspectorSnapshot;
  overview?: AgentOverviewSnapshot;
  todoPlan?: TodoPlanSnapshot;
  /**
   * 唯一的活动输入租约。一个 Agent 实例在任意时刻只能由一个输入请求
   * 消费用户回复；这是跨 reconnect / 多进程路由的归属锚点。
   */
  inputLease?: InputLease;
  // 运行期间排队等待的用户输入（用于输入框常驻 + 队列注入）
  queuedInputs: QueuedInput[];
  /**
   * 外部用户回合的接受策略，注册时声明。
   * 'standard'（默认）：接受聊天邮箱排队与输入租约。
   * 'none'：拒绝排队注入；测试沙盒等由宿主进程驱动输入的运行时使用。
   * 输入租约（interactive input request）不受此策略限制，仍由 feature 控制。
   */
  inputPolicy?: 'standard' | 'none';
}

export interface InputLease {
  requestId: string;
  prompt: string;
  placeholder?: string;
  initialValue?: string;
  actions?: UserInputAction[];
  mode?: UserInputRequestMode;
  questions?: UserInputQuestion[];
  timestamp: number;
}

/**
 * 排队的用户输入
 */
export interface QueuedInput {
  id: string;
  text: string;
  timestamp: number;
  /** 图片附件（多模态输入） */
  images?: ImageInput[];
  /** 稳定的输入来源标识，供宿主诊断和后续路由扩展使用 */
  source?: string;
  /** 来源侧事件/请求标识，不承担全局幂等语义 */
  sourceRef?: string;
  /** 随消息流动的能力激活通知（capability refs，如 skill.grill-me） */
  capabilityActivations?: string[];
}

/**
 * 一个不绑定具体 input request 的新用户回合。
 *
 * ViewerWorker 会原子决定：若存在兼容的文本 input request，则直接响应；
 * 否则进入该已连接 runtime 的会话邮箱，等待下一次兼容的文本输入租约。
 * 这覆盖新建/恢复会话在输入循环尚未打开的启动窗口，不依赖 callActive。
 */
export interface UserTurnInput {
  text: string;
  images?: ImageInput[];
  source?: string;
  sourceRef?: string;
  /** 随消息流动的能力激活通知（capability refs）；经 lease 响应 payload 与排队项原样随行 */
  capabilityActivations?: string[];
}

export type UserTurnSubmissionResult =
  | {
      success: true;
      delivery: 'input';
      requestId: string;
      source?: string;
      sourceRef?: string;
    }
  | {
      success: true;
      delivery: 'queued';
      id: string;
      queueLength: number;
      source?: string;
      sourceRef?: string;
    }
  | {
      success: false;
      code: 'agent_not_found' | 'invalid_input' | 'input_mode_conflict' | 'runtime_not_accepting_input';
      error: string;
      pendingMode?: UserInputRequestMode;
    };

/**
 * DebugHub IPC 消息类型（主进程 → Worker）
 * 使用 discriminated union 确保类型安全
 */
export type DebugHubIPCMessage =
  | RegisterAgentMsg
  | UpdateAgentInspectorMsg
  | UpdateAgentOverviewMsg
  | UpdateTodoPlanMsg
  | PushMessagesMsg
  | RegisterToolsMsg
  | UnregisterAgentMsg
  | PushNotificationMsg
  | RequestInputMsg
  | InputRequestCancelledMsg
  | InterruptAgentMsg
  | StopMsg;

/**
 * 注册新 Agent
 */
export interface RegisterAgentMsg {
  type: 'register-agent';
  agentId: string;
  name: string;
  createdAt: number;
  projectRoot?: string; // 项目根目录
  /**
   * 模板装载点：Feature 所属包的真实目录根（junction 已解析）。
   * Agent 侧是唯一知道权威 mount root 的一层（来自 feature.getPackageInfo()），
   * 注册只传事实，不做 URL 推导；URL 由 viewer-worker 分配。
   */
  templateMounts?: string[];
  /**
   * 模板名 → 装载条目。mount 为 templateMounts 数组下标，
   * rel 为该 mount root 下的相对路径（POSIX 分隔符）。
   */
  templateEntries?: Record<string, { mount: number; rel: string }>;
  hookInspector?: HookInspectorSnapshot;
  overview?: AgentOverviewSnapshot;
  activeInputRequest?: ActiveInputRequest; // 活跃的输入请求（用于重连后恢复）
  inputPolicy?: 'standard' | 'none'; // 外部用户回合接受策略（'none' = 拒绝排队注入）
}

export interface UpdateAgentInspectorMsg {
  type: 'update-agent-inspector';
  agentId: string;
  hookInspector: HookInspectorSnapshot;
}

export interface UpdateAgentOverviewMsg {
  type: 'update-agent-overview';
  agentId: string;
  overview: AgentOverviewSnapshot;
}

export interface UpdateTodoPlanMsg {
  type: 'update-todo-plan';
  agentId: string;
  plan: TodoPlanSnapshot;
}

/**
 * 推送 Agent 消息
 */
export interface PushMessagesMsg {
  type: 'push-messages';
  agentId: string;
  messages: Message[];
}

/**
  * 注册 Agent 工具
  */
export interface RegisterToolsMsg {
  type: 'register-tools';
  agentId: string;
  tools: Tool[];
}

/**
 * 活跃的输入请求（用于重连后恢复）
 */
export interface ActiveInputRequest {
  requestId: string;
  prompt: string;
  placeholder?: string;
  initialValue?: string;
  actions?: UserInputAction[];
  timestamp: number;
}

/**
 * 注销 Agent
 */
export interface UnregisterAgentMsg {
  type: 'unregister-agent';
  agentId: string;
}

/**
 * 停止 Worker
 */
export interface StopMsg {
  type: 'stop';
}

/**
 * 推送通知
 */
export interface PushNotificationMsg {
  type: 'push-notification';
  agentId: string;
  notification: Notification;
}

/**
 * 请求用户输入
 */
export interface RequestInputMsg {
  type: 'request-input';
  agentId: string;
  requestId: string;
  prompt: string;
  timeout?: number;
  placeholder?: string;
  initialValue?: string;
  actions?: UserInputAction[];
  mode?: UserInputRequestMode;
  questions?: UserInputQuestion[];
}

/**
 * 通知 Worker 一个输入请求已被运行时结算/取消（中断、销毁等）。
 * Worker 持有同名 inputLease 作为 HTTP 投递面；收到后应清除对应租约，
 * 否则陈旧租约会永久阻塞后续 user-turn（input_mode_conflict）。
 */
export interface InputRequestCancelledMsg {
  type: 'input-request-cancelled';
  agentId: string;
  requestId: string;
}

/**
 * 中断正在运行的 Agent
 */
export interface InterruptAgentMsg {
  type: 'interrupt-agent';
  agentId: string;
  clearQueue?: boolean;
}

/**
 * 用户输入响应（Worker → Agent，通过 UDS）
 */
export interface InputResponseMsg {
  type: 'input-response';
  agentId: string;
  requestId: string;
  input: string;
  response?: UserInputResponse;
}

export interface UserInputAction {
  id: string;
  label: string;
  kind?: 'rollback' | 'custom';
  variant?: 'primary' | 'secondary' | 'danger';
  payload?: Record<string, unknown>;
}

export type UserInputRequestMode = 'text' | 'choices';

export interface UserInputOption {
  id: string;
  label: string;
  description?: string;
  /** Whether this option allows supplementary free-text input */
  allowSupplement?: boolean;
  /** Whether the supplement text is required (only meaningful when allowSupplement is true) */
  supplementRequired?: boolean;
  /** Label shown above the supplement textarea */
  supplementLabel?: string;
  /** Placeholder for the supplement textarea */
  supplementPlaceholder?: string;
}

export interface UserInputQuestion {
  id: string;
  question: string;
  options: UserInputOption[];
  allowCustom?: boolean;
  customLabel?: string;
  customPlaceholder?: string;
}

export interface UserInputRequest {
  prompt: string;
  placeholder?: string;
  initialValue?: string;
  actions?: UserInputAction[];
  mode?: UserInputRequestMode;
  questions?: UserInputQuestion[];
}

export interface UserInputChoiceAnswer {
  questionId: string;
  optionId?: string;
  customText?: string;
  /** Supplementary free-text provided alongside the selected option */
  supplementText?: string;
}

export interface UserInputResponse {
  kind: 'text' | 'action' | 'choices';
  text?: string;
  actionId?: string;
  choices?: UserInputChoiceAnswer[];
  payload?: Record<string, unknown>;
}

/**
 * Worker → 主进程 消息
 */
export type WorkerIPCMessage =
  | ReadyMsg
  | InputResponseMsg;

/**
 * Worker 就绪
 */
export interface ReadyMsg {
  type: 'ready';
}

// ========== 上下文管理类型 ==========
/**
 * 消息标签枚举
 *
 * 用于快速分类和过滤消息，一条消息可能有多个标签
 */
export type MessageTag =
  | 'user'           // 用户输入消息
  | 'system'         // 系统消息
  | 'assistant'      // LLM 响应消息
  | 'tool-call'      // assistant 消息且包含 toolCalls
  | 'tool-result'    // role === 'tool' 的工具执行结果
  | 'sub-agent'      // 来自子代理的消息（与 assistant/tool-result 组合使用）
  | 'reminder';      // Feature 注入的提醒消息（与 system 组合使用）

/**
 * 解析结果结构
 *
 * 从消息 content 中提取的结构化信息
 */
export interface ParsedContent {
  /** 从 content 提取的任务 ID（正则匹配 "taskId":"xxx"） */
  taskIds: string[];
  /** 从 content 提取的工具调用名称（从 toolCalls 或 content 解析） */
  toolCalls: string[];
  /** @ 提及的内容 */
  mentions: string[];
  /** 用户可继承扩展更多字段 */
  [key: string]: any;
}

/**
 * 消息元数据
 *
 * 用于 addMessage() 的元数据参数
 */
export interface MessageMeta {
  /** ReAct 循环轮次 */
  turn: number;
  /** 子代理 ID（子代理消息时填写） */
  agentId?: string;
  /** 来源 Feature（reminder 等消息时填写） */
  source?: string;
  /** 消息语义标签（透传到 EnrichedMessage） */
  tag?: string;
}

/**
 * 扩展的消息结构
 *
 * 在原始 Message 基础上添加元数据
 * 不破坏现有 Message 类型，保证 LLM 调用兼容性
 */
export interface EnrichedMessage extends Message {
  // === 元数据字段 ===

  /** 唯一标识（用于索引关联） */
  id: string;
  /** 消息产生时间戳（毫秒） */
  timestamp: number;
  /** 所属 ReAct 循环轮次（从 0 开始） */
  turn: number;
  /** 全局消息序号（从 0 开始递增） */
  sequence: number;
  /** 来源 Agent ID（子代理消息） */
  agentId?: string;
  /** 来源 Feature（如 'todo-feature'，仅 reminder 等） */
  source?: string;

  // === 分类标签 ===

  /** 消息分类标签（用于快速查询） */
  tags: MessageTag[];

  // === 解析结果 ===

  /** 从 content 中提取的结构化信息 */
  parsed: ParsedContent;
}

// ========== 生命周期类型 re-export ==========
// 生命周期类型从 lifecycle.ts 导出，保持类型定义集中管理
export type {
  AgentInitiateContext,
  AgentDestroyContext,
  CallStartContext,
  CallFinishContext,
  CallFinishReason,
  StepStartContext,
  StepFinishedContext,
  HookResult,
  ToolContext,
  ToolResult,
} from './lifecycle.js';

// ========== 决策上下文类型 ==========
/**
 * 决策上下文（反向钩子参数）
 *
 * 所有决策上下文的联合类型
 */
export type DecisionContext =
  | import('./lifecycle.js').AgentInitiateContext
  | import('./lifecycle.js').AgentDestroyContext
  | import('./lifecycle.js').CallStartContext
  | import('./lifecycle.js').CallFinishContext
  | import('./lifecycle.js').StepStartContext
  | import('./lifecycle.js').StepFinishedContext
  | import('./lifecycle.js').ToolContext
  | import('./lifecycle.js').ToolResult
  | import('./lifecycle.js').StepFinishDecisionContext
  | import('./lifecycle.js').ToolFinishedDecisionContext
  | import('./lifecycle.js').ToolResultTransformContext;

// ========== UDS 通信类型 ==========

/**
 * UDS 配置
 */
export interface UDSConfig {
  /** UDS 路径（默认自动检测平台） */
  path?: string;
  /** HTTP 端口（Web 界面） */
  httpPort?: number;
  /** 是否自动打开浏览器 */
  openBrowser?: boolean;
}

/**
 * 平台检测后的 UDS 路径
 */
export function getDefaultUDSPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\agentdev-viewer';
  }
  return '/tmp/agentdev-viewer.sock';
}
