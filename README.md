# AgentDev

一个**轻量、解耦、可扩展**的 AI Agent 框架，采用模块化 Feature 插件架构，提供强大的生命周期钩子系统和灵活的工具扩展机制。

## 特性

- **Feature 插件系统** - 可外挂的功能模块，支持 MCP、Skills、子代理等
- **4级生命周期钩子** - Agent/Call/Step/Tool 全方位控制
- **反向钩子装饰器** - 使用装饰器注册流程控制逻辑
- **Context 内核化** - 消息包装和查询能力内置
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
  - [数据源注册系统](#数据源注册系统)
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
# 终端 1：启动调试服务器
npm run server

# 终端 2：启动 agent
npm run agt
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

消息上下文管理器，维护对话历史，内置消息包装和查询能力：

```typescript
// 消息注入
context.addUserMessage(content, callIndex);
context.addAssistantMessage(response, callIndex);
context.addToolMessage(call, result, callIndex);

// 查询
context.query().byTag('tool-call').exec();
context.getByTurn(callIndex);
```

**概念说明**：
- **Call** = 用户一次完整的输入-输出交互
- **Step** = ReAct 循环中的单次迭代（LLM 调用 + 工具执行）

### Tool（工具）

工具是 Agent 与外部世界交互的接口，每个工具包含：
- **定义**：名称、描述、参数、执行函数
- **渲染**：前端展示模板

### Feature（功能模块）

Feature 是可外挂的功能模块，提供：
- 工具注册
- 上下文注入
- 生命周期钩子（正向和反向）

---

## 架构设计

### 项目结构

```
AgentDev/
├── src/
│   ├── core/                  # 核心模块
│   │   ├── agent/            # Agent 子模块
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
│   │   ├── hooks-decorator.ts # 反向钩子装饰器
│   │   ├── hooks-registry.ts  # 钩子注册表
│   │   ├── debug-hub.ts       # 调试中心
│   │   └── config.ts          # 配置管理
│   ├── agents/                # 预置 Agent
│   │   └── system/
│   │       ├── BasicAgent.ts      # 基础 Agent
│   │       └── ExplorerAgent.ts   # 探索 Agent
│   ├── features/              # Feature 模块（目录结构）
│   │   ├── mcp/              # MCP 集成
│   │   │   ├── index.ts
│   │   │   └── templates/
│   │   ├── skill/            # Skills 系统
│   │   │   ├── index.ts
│   │   │   ├── tools.ts
│   │   │   └── templates/
│   │   ├── subagent/         # 子代理
│   │   │   ├── index.ts
│   │   │   ├── tools.ts
│   │   │   ├── pool.ts
│   │   │   └── templates/
│   │   ├── todo/             # 任务管理
│   │   │   ├── index.ts
│   │   │   ├── tools.ts
│   │   │   ├── types.ts
│   │   │   └── templates/
│   │   ├── shell/            # Shell 命令
│   │   │   ├── index.ts
│   │   │   └── tools.ts
│   │   ├── user-input/       # 用户输入
│   │   │   └── index.ts
│   │   └── index.ts          # 统一导出
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
│ System  │ │Registry│ │ Composer │
└─────────┘ └───────┘ └─────────┘
```

---

## 生命周期钩子

AgentDev 提供 4 级生命周期钩子系统 + 反向钩子装饰器：

### 正向钩子（通知）

| 级别 | 钩子 | 调用时机 | 返回值 |
|------|------|----------|--------|
| **Agent** | `onInitiate`, `onDestroy` | 一次初始化/销毁 | void |
| **Call** | `onCallStart`, `onCallFinish` | 每次 `onCall()` | void |
| **Step** | `onStepStart`, `onStepFinished` | 每轮 ReAct 循环 | HookResult |
| **Tool** | `onToolUse`, `onToolFinished` | 工具执行前后 | HookResult |

### 反向钩子（流程控制）

Feature 使用装饰器注册反向钩子，实现流程控制：

```typescript
import { StepFinish, ToolUse, ToolFinished, Decision } from '../core/hooks-decorator.js';

export class MyFeature implements AgentFeature {
  // 流程控制型：单个 Feature 内只能修饰一个方法
  @ToolUse
  async blockDangerousTools(ctx) {
    if (ctx.call.name === 'dangerous_tool') {
      return Decision.Deny; // 阻止执行
    }
    return Decision.Continue; // 使用默认行为（允许执行）
  }

  @StepFinish
  async handleSubAgents(ctx) {
    if (this.hasActiveAgents()) {
      await this.waitForAgents();
      return Decision.Approve; // 强制继续循环
    }
    return Decision.Continue; // 使用默认行为
  }

  // 纯通知型：可修饰多个方法
  @ToolFinished
  async logToolExecution(ctx) {
    console.log(`Tool ${ctx.toolName} executed`);
  }

  @ToolFinished
  async trackMetrics(ctx) {
    this.metrics.record(ctx.duration);
  }
}
```

### Decision 枚举

| 值 | 含义 | 使用场景 |
|---|------|---------|
| `Approve` | 确认/继续 | 强制继续循环或确认操作 |
| `Deny` | 拒绝/停止 | 强制结束循环或阻止操作 |
| `Continue` | 使用默认行为 | 交给系统默认逻辑 |

**默认行为规则**：
- `@StepFinish` Continue → 无工具时自然结束，有工具时继续循环
- `@ToolUse` Continue → 允许工具执行
- `@ToolFinished` 纯通知，无决策

### 钩子返回值（HookResult）

```typescript
type HookResult =
  | { action: 'block'; reason?: string }  // 阻止执行
  | { action: 'allow' }                   // 允许执行
  | { action: 'continue' }                // 继续循环
  | { action: 'end' }                     // 结束循环
  | undefined;                            // 默认行为
```

---

## 工具系统

### 工具渲染模板概述

每个工具可以配置前端渲染模板，用于在调试界面中美观地展示工具调用和结果。

**两种工具类型**：
1. **Feature 工具**：属于某个 Feature 模块，模板放在 Feature 的 `templates/` 目录
2. **系统工具**：独立的工具文件，模板放在 `src/tools/` 目录

---

### 创建 Feature 工具（推荐）

**目录结构**：

```
src/features/my-feature/
├── index.ts           # Feature 类
├── tools.ts           # 工具定义
└── templates/         # 渲染模板目录
    └── my-tool.render.ts
```

**步骤 1：创建渲染模板**

```typescript
// src/features/my-feature/templates/my-tool.render.ts
import type { InlineRenderTemplate } from '../../../core/types.js';

function escapeHtml(text: unknown): string {
  const str = String(text);
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
    '"': '&quot;', "'": '&#39;'
  })[m]!);
}

const myToolRender: InlineRenderTemplate = {
  // 调用时显示
  call: (args: { input: string }) => `
    <div class="tool-call">
      <strong>输入:</strong> ${escapeHtml(args.input)}
    </div>
  `,

  // 结果显示
  result: (data: unknown) => `
    <div class="tool-result">
      <strong>输出:</strong> ${escapeHtml(data)}
    </div>
  `
};

export default myToolRender;
```

**步骤 2：创建工具定义**

```typescript
// src/features/my-feature/tools.ts
import { createTool } from '../../core/tool.js';
import type { Tool } from '../../core/types.js';

export const myTool: Tool = createTool({
  name: 'my_tool',
  description: '我的工具',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string' }
    }
  },
  // 引用模板名称（与文件名对应）
  render: { call: 'my-tool', result: 'my-tool' },

  execute: async ({ input }) => {
    return `处理结果: ${input}`;
  }
});
```

**步骤 3：在 Feature 类中注册模板**

```typescript
// src/features/my-feature/index.ts
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { AgentFeature } from '../../core/types.js';
import { myTool } from './tools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class MyFeature implements AgentFeature {
  readonly name = 'my-feature';
  readonly dependencies: string[] = [];

  getTools() {
    return [myTool];
  }

  // 声明模板路径映射（模板名 -> 文件路径）
  getTemplatePaths(): Record<string, string> {
    return {
      'my-tool': join(__dirname, 'templates', 'my-tool.render.js'),
    };
  }
}
```

---

### 创建系统工具

**目录结构**：

```
src/tools/system/
├── my-tool.ts           # 工具定义
└── index.render.ts      # 统一的模板导出
```

**步骤 1：创建工具定义**

```typescript
// src/tools/system/my-tool.ts
import { createTool } from '../../core/tool.js';
import type { Tool } from '../../core/types.js';

export const mySystemTool: Tool = createTool({
  name: 'my_system_tool',
  description: '系统工具',
  parameters: {
    type: 'object',
    properties: {
      param: { type: 'string' }
    }
  },
  render: { call: 'my-system-tool', result: 'my-system-tool' },

  execute: async ({ param }) => {
    return `系统处理: ${param}`;
  }
});
```

**步骤 2：在 index.render.ts 中导出模板**

```typescript
// src/tools/system/index.render.ts
import type { InlineRenderTemplate } from '../../core/types.js';

function escapeHtml(text: unknown): string {
  // ...（同上）
}

const mySystemToolRender: InlineRenderTemplate = {
  call: (args) => `<div>系统工具: ${escapeHtml(args.param)}</div>`,
  result: (data) => `<div>结果: ${escapeHtml(data)}</div>`
};

// 统一导出所有渲染模板
export const TEMPLATES: Record<string, any> = {
  'my-system-tool': mySystemToolRender,
  // ... 其他模板
};
```

**步骤 3：更新 viewer-worker.ts 的系统模板映射**

```typescript
// src/core/viewer-worker.ts
const SYSTEM_TEMPLATE_MAP = {
  // ... 其他映射
  'my-system-tool': 'system/index',
};
```

---

### Render 配置格式

| 格式 | 说明 | 示例 |
|------|------|------|
| **字符串简写** | call 和 result 使用相同模板 | `render: 'my-template'` |
| **对象配置** | call 和 result 使用不同模板 | `render: { call: 'call-tpl', result: 'result-tpl' }` |
| **内联模板** | 直接定义模板（不推荐） | `render: { call: { call: fn }, result: { result: fn } }` |

---

### 模板文件命名规范

| 工具名 | 模板文件名 | 模板名 |
|--------|-----------|--------|
| `my_tool` | `my-tool.render.ts` | `my-tool` |
| `safe_trash_delete` | `safe-trash-delete.render.ts` | `safe-trash-delete` |
| `invokeSkill` | `invoke-skill.render.ts` | `invoke-skill` |

**规则**：
- 工具名的 snake_case → 模板名的 kebab-case
- 模板文件名必须与模板名一致

---

### 内置工具

| 分类 | 工具 | 说明 |
|------|------|------|
| **文件操作** | `read` | 读取文件（支持分页、二进制检测） |
| | `write` | 写入文件（带 diff 预览） |
| | `edit` | 编辑文件（9种智能匹配策略） |
| | `glob` | 文件搜索（glob 模式） |
| | `grep` | 内容搜索（基于 ripgrep） |
| | `ls` | 目录列表（树形结构） |
| **系统工具** | `bash` | Shell 命令执行（Shell Feature） |
| | `web` | HTTP 请求 |
| | `math` | 计算器 |
| **Feature 工具** | `invoke_skill` | 调用 Skill（SkillFeature） |
| | `spawn_agent` | 创建子代理（SubAgentFeature） |
| | `wait` | 等待子代理（SubAgentFeature） |
| | `get_user_input` | 获取用户输入（UserInputFeature） |
| | `safe_trash_delete` | 安全删除（Shell Feature） |
| | `safe_trash_list` | 垃圾桶列表（Shell Feature） |
| | `safe_trash_restore` | 恢复文件（Shell Feature） |

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

  /** 获取模板路径映射（Feature 目录化后新增） */
  getTemplatePaths?(): Record<string, string>;

  /** 上下文注入器 */
  getContextInjectors?(): Map<string | RegExp, ContextInjector>;

  /** 初始化钩子 */
  onInitiate?(ctx: FeatureInitContext): Promise<void>;

  /** 清理钩子 */
  onDestroy?(ctx: FeatureContext): Promise<void>;
}
```

### Feature 目录结构

```
src/features/feature-name/
├── index.ts           # Feature 类（必需）
├── tools.ts           # 工具定义（如有工具）
├── templates/         # 渲染模板（如有渲染）
│   └── *.render.ts
├── types.ts           # 类型定义（按需）
└── pool.ts            # 辅助类（按需）
```

**要点**：
- 工具使用工厂函数创建（需要 Feature 实例访问）
- 模板通过 `getTemplatePaths()` 声明映射
- 前端加载时优先查找 Feature 模板，再回退到系统模板

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

子代理管理和通信（使用反向钩子装饰器）：

```typescript
// 自动启用，提供 spawn_agent、wait 等工具
const result = await agent.onCall(`
  创建一个子代理来分析这个文件
`);
```

#### UserInputFeature

通过调试界面获取用户输入：

```typescript
import { UserInputFeature } from './src/features/index.js';

const agent = new BasicAgent()
  .use(new UserInputFeature({ timeout: 300000 }))
  .withViewer('MyAgent', 2026);

const input = await userInputFeature.getUserInput('请输入：');
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

### 数据源注册系统

Feature 可以通过 `DataSourceRegistry` 注册命名数据源：

```typescript
import { DataSourceRegistry } from './src/template/data-source.js';

class MyFeature implements AgentFeature {
  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    DataSourceRegistry.register({
      name: 'myItems',
      getData: () => this.items,
      renderItem: (item, template, ctx) => {
        return PlaceholderResolver.resolve(template, { ...ctx, ...item });
      },
    });
  }
}
```

**内置数据源**：`skills`（由 SkillFeature 自动注册）

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
  "agent": {
    "maxTurns": 10,
    "temperature": 0.7
  }
}
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

---

## 注意事项

### 编译要求

**必须先编译再运行**：

```bash
npm run build  # 编译 .render.ts → .js
npm run agt    # 运行 agent
```

**原因**：工具的渲染模板需要从 TypeScript 编译为 JavaScript 才能被前端动态加载。

### 渲染模板常见问题

**问题 1：工具显示 JSON 而非自定义模板**

| 原因 | 解决方案 |
|------|----------|
| 模板文件不存在 | 检查 `dist/` 目录下是否有编译后的 `.render.js` 文件 |
| 模板导出格式错误 | Feature 模板使用 `export default`，系统模板导出 `TEMPLATES` 对象 |
| 模板名拼写错误 | 确认工具的 `render` 配置与 `getTemplatePaths()` 中的 key 一致 |

**问题 2：浏览器控制台出现 404 错误**

```
GET http://localhost:2026/features/my-feature/my-tool.render.js 404
```

| 检查项 | 命令 |
|--------|------|
| 文件是否存在 | `ls dist/features/my-feature/templates/` |
| 路径映射是否正确 | 在浏览器控制台检查 `FEATURE_TEMPLATE_MAP` |
| 重新编译 | `npm run build` |

**问题 3：模板加载返回 undefined**

```javascript
// 浏览器控制台
console.log(FEATURE_TEMPLATE_MAP['my-tool']);  // undefined
```

**排查步骤**：
1. 检查 `getTemplatePaths()` 是否返回了正确的映射
2. 检查路径是否使用 `.js` 扩展名（编译后）
3. 检查 Agent 是否成功注册到 DebugHub

**调试技巧**：

```javascript
// 浏览器控制台
// 1. 检查 Feature 模板映射
console.log('Feature Templates:', FEATURE_TEMPLATE_MAP);

// 2. 检查系统模板映射
console.log('System Templates:', SYSTEM_TEMPLATE_MAP);

// 3. 手动测试模板解析
console.log('Resolved Path:', resolveTemplatePath('my-tool'));
```

### 端口冲突

默认调试端口为 **2026**。如遇"地址已使用"错误：

```bash
# Windows
netstat -ano | findstr :2026
taskkill /PID <pid> /F

# Linux/macOS
lsof -i :2026
kill -9 <pid>
```

### 钩子执行顺序

```
onCallStart
  → onInitiate (首次)
  → [ReAct Loop]
    → onStepStart
    → 反向钩子 @StepStart (纯通知，多个)
    → LLM 调用
    → [每个工具]
      → 反向钩子 @ToolUse (流程控制，单个) ← 可在此阻塞
      → onToolUse
      → 工具执行
      → onToolFinished
      → 反向钩子 @ToolFinished (纯通知，多个)
    → onStepFinished
    → 反向钩子 @StepFinish (流程控制，单个)
  → onCallFinish
```

---

## 许可证

MIT
