# AgentDev

一个**轻量、解耦、可扩展**的 AI Agent 框架，采用模块化 Feature 插件架构，提供强大的生命周期钩子系统和灵活的工具扩展机制。

## 特性

- **Feature 插件系统** - 可外挂的功能模块，支持 MCP、Skills、子代理等
- **5级生命周期钩子** - Agent/Call/Turn/LLM/Tool 全方位控制
- **灵活的工具系统** - 双文件模式（定义+渲染），支持前端动态模板
- **内置可视化调试** - DebugHub 多 Agent 调试中心
- **开箱即用** - BasicAgent 提供默认工具集和配置
- **跨平台兼容** - 完整的 Windows/Linux/macOS 支持

## 目录

- [快速开始](#快速开始)
- [核心概念](#核心概念)
- [架构设计](#架构设计)
- [生命周期钩子](#生命周期钩子)
- [工具系统](#工具系统)
- [Feature 系统](#feature-系统)
- [模板系统](#模板系统)
- [配置管理](#配置管理)
- [API 参考](#api-参考)
- [注意事项](#注意事项)

---

## 快速开始

### 安装依赖

```bash
npm install
```

### 配置 LLM

编辑 `config/default.json`：

```json
{
  "defaultModel": {
    "provider": "openai",
    "model": "gpt-4o",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-xxx"
  },
  "agent": {
    "maxTurns": 10
  }
}
```

### 编译项目

```bash
npm run build
```

> **注意**：必须先编译，因为工具的渲染模板需要从 `.render.ts` 编译为 `.js` 才能被前端加载。

### 运行 Agent

```bash
npm run agt    # 启动 agent（端口 2026）
```

---

## 核心概念

### Agent

Agent 是系统的核心协调器，采用 ReAct（Reasoning + Acting）循环架构：

```typescript
┌─────────────────────────────────────────────┐
│ 1. 接收用户输入                               │
│ 2. 调用 LLM 获取响应                          │
│ 3. 判断是否有工具调用                          │
│    ├─ 有 → 执行工具 → 回到步骤 2               │
│    └─ 无 → 返回最终响应                        │
└─────────────────────────────────────────────┘
```

### Context（上下文）

消息上下文管理器，维护对话历史：

```typescript
// 保存/恢复上下文
const snapshot = agent.save();        // 保存快照
agent.load(snapshot);                 // 恢复快照
agent.reset();                        // 清空上下文
```

### Tool（工具）

工具是 Agent 与外部世界交互的接口，每个工具包含：
- **定义**：名称、描述、参数、执行函数
- **渲染**：前端展示模板

### Feature（功能模块）

Feature 是可外挂的功能模块，提供：
- 工具注册
- 上下文注入
- 生命周期钩子

---

## 架构设计

### 项目结构

```
AgentDev/
├── src/
│   ├── core/                  # 核心模块
│   │   ├── agent/            # Agent 子模块（重构后）
│   │   │   ├── hooks-executor.ts   # 钩子执行器
│   │   │   ├── lifecycle-hooks.ts  # 生命周期钩子
│   │   │   ├── react-loop.ts       # ReAct 循环
│   │   │   ├── template-resolver.ts # 模板解析器
│   │   │   └── tool-executor.ts    # 工具执行器
│   │   ├── agent.ts           # Agent 主类
│   │   ├── context.ts         # 消息上下文
│   │   ├── tool.ts            # 工具系统
│   │   ├── feature.ts         # Feature 接口
│   │   ├── lifecycle.ts       # 生命周期类型
│   │   ├── debug-hub.ts       # 调试中心
│   │   └── config.ts          # 配置管理
│   ├── agents/                # 预置 Agent
│   │   └── system/
│   │       ├── BasicAgent.ts      # 基础 Agent
│   │       └── ExplorerAgent.ts   # 探索 Agent
│   ├── features/              # Feature 模块
│   │   ├── mcp.js            # MCP 集成
│   │   ├── skill.js          # Skills 系统
│   │   ├── subagent.js       # 子代理
│   │   └── todo.js           # 任务管理
│   ├── tools/                 # 工具定义
│   │   ├── opencode/         # 文件操作（read, write, edit...）
│   │   ├── system/           # 系统工具（shell, web, math...）
│   │   └── user/             # 用户自定义工具
│   ├── template/              # 模板系统
│   ├── llm/                   # LLM 集成
│   └── mcp/                   # MCP 协议
├── config/                     # 配置文件
│   └── default.json
├── .agentdev/                  # Agent Dev 环境
│   └── skills/                # Skills 定义目录
└── examples/                   # 示例代码
```

### 模块依赖关系

```
         ┌─────────────┐
         │   Agent     │
         └──────┬──────┘
                │
      ┌─────────┼─────────┐
      │         │         │
┌─────▼───┐ ┌──▼────┐ ┌──▼──────┐
│ Feature │ │ Tool  │ │ Template │
│ System  │ │Registry│ │Composer │
└─────────┘ └───────┘ └─────────┘
```

---

## 生命周期钩子

AgentDev 提供 5 级生命周期钩子系统：

| 级别 | 钩子 | 调用时机 | 返回值支持 |
|------|------|----------|-----------|
| **Agent** | `onInitiate`, `onDestroy` | 一次初始化/销毁 | void |
| **Call** | `onCallStart`, `onCallFinish` | 每次 `onCall()` | void |
| **Turn** | `onTurnStart`, `onTurnFinished` | 每轮 ReAct 循环 | HookResult |
| **LLM** | `onLLMStart`, `onLLMFinish` | LLM 调用前后 | HookResult |
| **Tool** | `onToolUse`, `onToolFinished` | 工具执行前后 | HookResult |

### 钩子返回值（HookResult）

```typescript
type HookResult =
  | { action: 'block'; reason?: string }  // 阻止执行
  | { action: 'allow' }                   // 允许执行
  | { action: 'continue' }                // 继续循环
  | { action: 'end' }                     // 结束循环
  | undefined;                            // 默认行为
```

### 错误处理策略

```typescript
enum HookErrorHandling {
  Silent,    // 记录警告，继续执行
  Propagate, // 抛出错误，中断流程
  Logged,    // 记录错误然后抛出
}
```

默认策略：
- **Agent/Turn** 钩子：`Silent`
- **Call/LLM/Tool** 钩子：`Propagate`

### 使用示例

```typescript
class MyAgent extends Agent {
  // 阻止特定工具执行
  protected async onToolUse(ctx: ToolContext): Promise<HookResult> {
    if (ctx.call.name === 'dangerous_tool') {
      return { action: 'block', reason: '此工具已被禁用' };
    }
    return undefined;
  }

  // 强制继续循环
  protected async onLLMFinish(ctx: LLMFinishContext): Promise<HookResult> {
    if (!ctx.response.toolCalls?.length) {
      // 即使没有工具调用，也继续循环
      return { action: 'continue' };
    }
    return undefined;
  }

  // 记录每次调用完成
  protected async onCallFinish(ctx: CallFinishContext): Promise<void> {
    console.log(`调用完成: ${ctx.response} (${ctx.turns} 轮)`);
  }
}
```

---

## 工具系统

### 工具定义模式

每个工具由 **2 个文件**组成：

```
src/tools/category/
├── [name].ts           # 工具定义
└── [name].render.ts    # 渲染模板
```

### 创建工具

**文件 1：工具定义**

```typescript
// src/tools/user/my-tool.ts
import { createTool } from '../../core/tool.js';

export const myTool = createTool({
  name: 'my_tool',
  description: '我的自定义工具',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: '输入参数' }
    }
  },
  execute: async (args) => {
    return `处理结果: ${args.input}`;
  },
  render: 'my-template'  // 模板名称
}, import.meta.url);     // 传递源文件路径用于自动查找渲染文件
```

**文件 2：渲染模板**

```typescript
// src/tools/user/my-tool.render.ts
import { escapeHtml, formatError } from '../system/index.render.js';

// 渲染函数
export const render = {
  call: (data: { input: string }) => `
    <div class="tool-call">
      <strong>输入:</strong> ${escapeHtml(data.input)}
    </div>
  `,
  result: (data: { output: string }, success: boolean) => {
    if (!success) {
      return `<div class="error">${formatError(data.output as string)}</div>`;
    }
    return `
      <div class="tool-result">
        <strong>输出:</strong> ${escapeHtml(data.output)}
      </div>
    `;
  }
};

// 模板映射表
export const TEMPLATES = {
  'my-template': render
};
```

### 注册工具

```typescript
// 在 index.render.ts 中添加导出
export * from './my-tool.render.js';

// 在模板映射表中添加
export const TEMPLATES = {
  // ...其他模板
  'my-template': render
};

// 在 src/core/viewer-worker.ts 的 templateToFileMap 中添加
const templateToFileMap = {
  // ...其他映射
  'my-template': 'user/my-tool'
};
```

### Render 字段格式

```typescript
// 格式 A: 简写（call 和 result 使用同一模板）
render: 'my-template'

// 格式 B: 对象（call 和 result 使用不同模板）
render: { call: 'my-call', result: 'my-result' }

// 格式 C: 内联（直接定义渲染函数）
render: {
  call: (data) => `<div>...</div>`,
  result: (data, success) => success ? `<div>...</div>` : `<div>错误</div>`
}
```

### 内置工具

| 分类 | 工具 | 说明 |
|------|------|------|
| **文件操作** | `read` | 读取文件（支持分页、二进制检测） |
| | `write` | 写入文件（带 diff 预览） |
| | `edit` | 编辑文件（9种智能匹配策略） |
| | `glob` | 文件搜索（glob 模式） |
| | `grep` | 内容搜索（基于 ripgrep） |
| | `ls` | 目录列表（树形结构） |
| **系统工具** | `shell` | Shell 命令执行 |
| | `web` | HTTP 请求 |
| | `math` | 计算器 |
| **Feature 工具** | `invoke_skill` | 调用 Skill（SkillFeature） |
| | `spawn_agent` | 创建子代理（SubAgentFeature） |
| | `wait` | 等待子代理（SubAgentFeature） |

---

## Feature 系统

Feature 是可外挂的功能模块，支持声明式注册和统一的生命周期管理。

### Feature 接口

```typescript
interface AgentFeature {
  /** Feature 名称 */
  readonly name: string;

  /** 获取同步工具 */
  getTools?(): Tool[];

  /** 获取异步工具 */
  getAsyncTools?(ctx: FeatureInitContext): Promise<Tool[]>;

  /** 上下文注入器 */
  getContextInjectors?(): Map<string | RegExp, ContextInjector>;

  /** 初始化钩子 */
  onInitiate?(ctx: FeatureInitContext): Promise<void>;

  /** 清理钩子 */
  onDestroy?(ctx: FeatureContext): Promise<void>;
}
```

### 使用 Feature

```typescript
import { BasicAgent } from './src/index.js';
import { MCPFeature, SkillFeature, SubAgentFeature } from './src/features/index.js';

const agent = new BasicAgent()
  .use(new MCPFeature('github'))        // MCP 集成
  .use(new SkillFeature('./skills'))    // Skills 管理
  .use(new SubAgentFeature());          // 子代理管理
```

### 内置 Feature

#### MCPFeature

集成 Model Context Protocol：

```typescript
const agent = new BasicAgent({
  mcpServer: 'github',  // 自动加载 .agentdev/mcps/github.json
  mcpContext: {         // 运行时上下文
    githubToken: process.env.GITHUB_TOKEN
  }
});
```

#### SkillFeature

管理 Skills 系统：

```typescript
const agent = new BasicAgent({
  skillsDir: './my-skills'  // 自定义 Skills 目录
});
```

#### SubAgentFeature

子代理管理和通信：

```typescript
// 自动启用，提供 spawn_agent、wait 等工具
const result = await agent.onCall(`
  创建一个子代理来分析这个文件
`);
```

---

## 模板系统

### TemplateComposer

流式构建提示词：

```typescript
import { TemplateComposer } from './src/template/composer.js';

const prompt = new TemplateComposer()
  .add('你是一个助手\n')
  .add({ file: 'system.md' })                    // 文件模板
  .add({ skills: '- {{name}}: {{description}}' }) // Skills 模板
  .add({ conditional: {                           // 条件模板
    part: '启用功能: {{feature}}',
    condition: (ctx) => ctx.feature !== undefined
  }})
  .build(context);
```

### 模板来源

| 来源 | 格式 | 说明 |
|------|------|------|
| 字符串 | `'text'` | 直接字符串 |
| 文件 | `{ file: 'path' }` | 从文件加载 |
| Skills | `{ skills: 'template' }` | 渲染 Skills 列表 |
| 条件 | `{ conditional: {...} }` | 条件渲染 |

### 占位符

模板支持 `{{key}}` 占位符，从 PlaceholderContext 解析：

```typescript
agent.setSystemContext({
  name: '助手',
  version: '1.0.0',
  currentDate: new Date().toISOString()
});

// 模板: "我是 {{name}}，版本 {{version}}"
// 结果: "我是 助手，版本 1.0.0"
```

---

## 配置管理

### 配置文件结构

`config/default.json`：

```json
{
  "defaultModel": {
    "provider": "openai",
    "model": "gpt-4o",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "${OPENAI_API_KEY}"
  },
  "defaultModel1": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "baseUrl": "https://api.anthropic.com/v1",
    "apiKey": "${ANTHROPIC_API_KEY}"
  },
  "agent": {
    "maxTurns": 10,
    "temperature": 0.7
  }
}
```

### 加载配置

```typescript
import { loadConfigSync } from './src/core/config.js';

// 同步加载
const config = loadConfigSync('default');

// 列出所有配置
const configs = listConfigs();  // ['default', 'production', ...]
```

### 环境变量

配置文件支持 `${VAR}` 环境变量替换：

```json
{
  "apiKey": "${OPENAI_API_KEY}",
  "baseUrl": "${API_BASE_URL:-https://api.openai.com/v1}"
}
```

---

## API 参考

### Agent

```typescript
import { Agent } from './src/core/agent.js';

const agent = new Agent({
  llm: llmClient,
  tools: [tool1, tool2],
  maxTurns: 10,
  systemMessage: '你是一个助手'
});

// 主要方法
const response = await agent.onCall('用户输入');
agent.setSystemPrompt('新的系统提示词');
agent.setSystemContext({ key: 'value' });
agent.withContext(context);
agent.reset();
agent.dispose();
```

### BasicAgent

```typescript
import { BasicAgent } from './src/agents/system/BasicAgent.js';

const agent = new BasicAgent({
  configName: 'default',    // 配置文件名
  name: 'MyAgent',          // 显示名称
  mcpServer: 'github',       // MCP 服务器
  skillsDir: './skills'      // Skills 目录
});

const result = await agent.onCall('你好');
```

### 创建工具

```typescript
import { createTool } from './src/core/tool.js';

const tool = createTool({
  name: 'tool_name',
  description: '工具描述',
  parameters: {
    type: 'object',
    properties: {
      param1: { type: 'string', description: '参数1' }
    }
  },
  execute: async (args, context) => {
    return '执行结果';
  },
  render: 'template-name'  // 可选
}, import.meta.url);
```

### DebugHub

```typescript
import { DebugHub } from './src/core/debug-hub.js';

const agent = await new BasicAgent()
  .withViewer('MyAgent', 2026, true);  // name, port, openBrowser

// DebugHub 会自动启动调试服务器
// 访问 http://localhost:2026 查看调试界面
```

---

## 注意事项

### 编译要求

**必须先编译再运行**：

```bash
npm run build  # 编译 .render.ts → .js
npm run agt    # 运行 agent
```

原因：工具的渲染模板需要从 `.render.ts` 编译为 `.js` 才能被前端动态加载。

### 端口冲突

默认调试端口为 **2026**。如遇"地址已使用"错误：

```typescript
// 更换端口
await agent.withViewer('MyAgent', 3000, true);
```

或关闭占用进程：

```bash
# Windows
netstat -ano | findstr :2026
taskkill /PID <pid> /F

# Linux/macOS
lsof -i :2026
kill -9 <pid>
```

### Windows 路径处理

返回路径时使用反引号包裹，避免 markdown 转义：

```typescript
// ❌ 错误：\c 会被渲染为特殊字符
return `路径：${basePath}`;

// ✅ 正确：用反引号包裹
return `路径：\`${basePath}\``;
```

### 钩子执行顺序

钩子按以下顺序执行：

```
onCallStart
  → onInitiate (首次)
  → [ReAct Loop]
    → onTurnStart
    → onLLMStart
    → onLLMFinish
    → onToolUse (每个工具)
    → onToolFinished (每个工具)
    → onTurnFinished
  → onCallFinish
```

### 工具上下文注入

某些工具需要额外的上下文参数：

```typescript
// invoke_skill 需要注入 skills 列表
// 在 agent.executeTool() 中自动处理
const data = await tool.execute(args, {
  _context: { skills: this.skills }
});
```

---

## 开发指南

### 创建自定义 Agent

```typescript
import { Agent } from './src/core/agent.js';

class MyAgent extends Agent {
  protected async onInitiate(ctx: AgentInitiateContext): Promise<void> {
    console.log('Agent 初始化');
  }

  protected async onToolUse(ctx: ToolContext): Promise<HookResult> {
    if (ctx.call.name === 'restricted') {
      return { action: 'block', reason: '不允许此工具' };
    }
    return undefined;
  }
}
```

### 创建自定义 Feature

```typescript
import type { AgentFeature } from './src/core/feature.js';

class MyFeature implements AgentFeature {
  readonly name = 'my-feature';

  getTools() {
    return [myTool1, myTool2];
  }

  getContextInjectors() {
    return new Map([
      ['my_tool', (call) => ({ customContext: 'value' })]
    ]);
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    console.log('Feature 初始化');
  }
}
```

---

## 许可证

MIT

---

## 贡献

欢迎提交 Issue 和 Pull Request！
