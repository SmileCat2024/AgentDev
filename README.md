# AgentDev

轻量、可扩展、面向 agent 的 TypeScript 框架。它把能力组织成 Feature，把对话消息、运行时日志、调试器状态拆开管理，并提供一个同时可被人和 agent 消费的调试器。

## 适合什么场景

- 想快速组一个带工具、MCP、skills、子代理的 agent
- 想把能力做成可复用的 Feature，而不是把逻辑散在一堆工具里
- 想在调试器里同时看到消息、工具、hooks、日志
- 想让外部客户端或另一个 agent 通过 MCP 只读观察当前运行状态

## 快速开始

### 1. 安装

```bash
npm install
```

### 2. 配置模型

编辑 `config/default.json`：

```json
{
  "defaultModel": {
    "provider": "openai",
    "model": "gpt-4o",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "${OPENAI_API_KEY}"
  },
  "agent": {
    "maxTurns": 10
  }
}
```

`provider` 现在支持：

- `openai`
- `anthropic`

框架会根据 `defaultModel.provider` 自动选择对应适配器，不需要切换 Agent 类。

OpenAI 兼容模型示例：

```json
{
  "defaultModel": {
    "provider": "openai",
    "model": "glm-4.7",
    "baseUrl": "https://open.bigmodel.cn/api/coding/paas/v4",
    "apiKey": "${OPENAI_API_KEY}",
    "maxTokens": 4096,
    "providerOptions": {
      "reasoning": {
        "enabled": true
      }
    }
  }
}
```

Anthropic 兼容模型示例：

```json
{
  "defaultModel": {
    "provider": "anthropic",
    "model": "glm-4.7",
    "baseUrl": "https://open.bigmodel.cn/api/anthropic",
    "apiKey": "${ANTHROPIC_API_KEY}",
    "maxTokens": 4096,
    "thinkingBudgetTokens": 4096,
    "thinkingKeepTurns": 5
  }
}
```

含义：

- `providerOptions`: OpenAI 路径的 provider 私有透传参数，用来控制 reasoning 等兼容字段
- `thinkingBudgetTokens`: Anthropic 路径开启 thinking 的预算；未配置时不主动开启
- `thinkingKeepTurns`: Anthropic 路径保留最近几轮 thinking block 的轮数，默认 `5`

### 3. 编译

```bash
npm run build
```

这是必需步骤。调试器加载的模板文件来自编译后的 `.render.js`。

### 4. 启动调试器

当前有两种后端模式：

- 旧模式：本仓库内置 `ViewerWorker`
- 新模式：独立宿主 `AgentDevClaw`，可作为 runtime 或 Electron 桌面应用运行

如果你只是要快速验证本仓库的旧链路，仍然可以启动 `ViewerWorker`：

```bash
npm run server
```

默认地址：

- Web UI: `http://localhost:2026`
- Debugger MCP: `http://localhost:2026/mcp`

如果你要走当前推荐的独立宿主链路，启动 `D:\code\AgentDevClaw` 的 runtime 或桌面应用后，可直接运行：

```bash
npm run claw:smoke:runtime
```

这会保留 `DebugHub` 的现有调用方式，但把调试数据发送到独立的 Claw host，而不是本地 `ViewerWorker`。

当前能力边界：

- `claw` transport 已支持：agent 注册、messages、tools、hooks、overview、notification、logs、current agent 选择、交互式输入回传、模板分发、调试 MCP
- `AgentDev` 里可以通过 `getDebugCapabilities()` 判断当前 transport 能力

常用示例也可直接走 Claw runtime：

```bash
npm run claw:agent
npm run claw:ragent
npm run claw:qqbot
```

输入桥 smoke 验证：

```bash
npm run claw:verify:input
```

`AgentDevClaw` 默认地址：

- Web UI: `http://127.0.0.1:3030/`
- Debugger MCP: `http://127.0.0.1:3030/mcp`

如果你使用的是打包后的 Electron 宿主，页面仍然是原有熟悉的 DebugHub，而不是另一套新设计。

如果你想手动设置环境变量：

PowerShell:

```powershell
$env:AGENTDEV_DEBUG_TRANSPORT = 'claw'
$env:AGENTDEV_CLAW_RUNTIME_URL = 'http://127.0.0.1:3030'
npm run claw:smoke
```

cmd.exe:

```cmd
set AGENTDEV_DEBUG_TRANSPORT=claw
set AGENTDEV_CLAW_RUNTIME_URL=http://127.0.0.1:3030
npm run claw:smoke
```

### 5. 运行示例 agent

```bash
npm run agt
```

## 30 秒理解框架

### Agent

`Agent` 负责 ReAct 主循环：

1. 接收输入
2. 调用 LLM
3. 执行工具
4. 把结果再喂回下一轮
5. 直到自然结束或被 hook 改写

### Feature

Feature 是 AgentDev 的主要扩展单元。一个 Feature 通常会打包：

- 一组工具
- 工具模板
- 少量内部状态
- 上下文注入
- 初始化逻辑
- 反向钩子
- 可选的 rollback / restore 状态协议

### Step Checkpoint / Rollback / Session Restore

当前框架已经把“回退”和“恢复会话”统一成同一套快照语义：

- 每个 step 开始前，Agent 会创建 step checkpoint
- 如果该 step 内执行失败，会回滚 `Context` 和已声明的 Feature 状态
- 每次成功完成一轮 `onCall()`，Agent 会记录一个 pre-call checkpoint
- 会话恢复时，不是复活旧进程，而是启动一个新 Agent，再把它恢复到历史 checkpoint

这意味着：

- step rollback = 进程内回退
- session restore = 新实例恢复到旧 checkpoint
- 两者共享同一套 `Context + FeatureStateSnapshot` 思想

Feature 自己需要明确两类东西：

- 哪些内存状态要跟着 checkpoint 回退
- 哪些外部资源只能重建，不能序列化恢复

当前推荐的最小策略是：

- 可恢复内存状态：实现 `captureState()` / `restoreState()`
- rollback 生命周期：可选实现 `beforeRollback()` / `afterRollback()`
- 外部连接、worker、子进程：不要伪序列化，优先在恢复时重建，或显式降级

注意：

- rollback / session restore 不是所有 Feature 的必选项
- 只有当这个 Feature 的使用场景真的要求“回退后状态一致”或“恢复会话后继续成立”时，才需要实现状态快照
- 如果 Feature 本身几乎无状态，或者丢失运行态不会造成语义错误，就不要为了形式统一硬加快照接口

例如：

- `todo`、`opencode-basic`、`visual` 属于显式状态快照型 Feature
- `subagent` 属于运行态资源型 Feature，当前恢复策略是清空活跃运行态，而不是伪造继续执行

### Debugger

调试器不是只看消息的前端。它维护独立的 session 状态，当前包含：

- Overview
- Features
- Reverse Hooks
- Logs
- MCP

### Debugger MCP

当前 debugger host 会把同一份调试状态通过 MCP 只读暴露出去。默认内置：

- Tools: `list_agents`, `get_current_agent`, `get_agent`, `get_hooks`, `query_logs`
- Resources: `debug://agents`, `debug://agents/current`, `debug://agents/{agentId}`, `debug://agents/{agentId}/hooks`
- Prompts: `analyze_errors`, `review_hooks`, `diagnose_agent`

## 日志与调试语义

这一点很重要，因为它直接影响 agent 通过 MCP 能看到什么。

- 对话消息和运行时日志是两套独立数据
- `Logs` 面板和 `query_logs` 读取的是同一份结构化日志
- 只有成功送达 debugger hub 的日志会出现在 `query_logs` 结果里
- 如果日志产生时 debugger 未连接，日志会回退到本地 console，不会神奇地出现在 MCP 返回里

也就是说，当前系统已经尽量保证“要么进 Hub，要么明确本地回退”，而不是静默东一块西一块。

## LLM 兼容语义

当前内核以 OpenAI 风格消息语义为准，再把 Anthropic 当成定向编译目标，而不是再抽一层模糊的统一协议。

Anthropic 适配的关键规则：

- 首个 `user` 之前的所有 `system` 消息会编译到顶层 `system[]`
- 首个 `user` 之后再出现的 `system` 消息会编译成 `<reminder>...</reminder>` 注入后续 `user.content[]`
- `tool` 消息会编译成同一轮 `user.content[]` 里的 `tool_result`
- 开启 thinking 时，最近若干轮 assistant 的 thinking block 会按 Anthropic 原生 block 形式回放，支持连续思维

这意味着：

- 固定 agent 宪法适合放在前缀 `system`
- 运行时 reminder、step 提示、回退后补充约束等，应继续作为消息流的一部分存在
- Anthropic 的 caching / context management 能被充分利用，而不用把所有 system 文本粗暴拼接成一个大字符串

## 一个最小例子

```ts
import { BasicAgent } from './src/agents/system/BasicAgent.js';
import { TodoFeature, UserInputFeature } from './src/features/index.js';

const input = new UserInputFeature();

const agent = new BasicAgent({
  name: 'MyAgent',
}).use(new TodoFeature()).use(input);

await agent.withViewer('MyAgent', 2026, false);

while (true) {
  const text = await input.getUserInput('请输入：');
  if (!text || text === 'exit') break;
  const result = await agent.onCall(text);
  console.log(result);
}
```

## 创建 Feature 的建议入口

如果你准备扩展框架，建议先从 Feature 心智模型开始：

- 同步工具：`getTools()`
- 异步发现工具：`getAsyncTools()`
- 注入工具上下文：`getContextInjectors()`
- 注册模板：`getPackageInfo()` + `getTemplateNames()`
- 初始化资源：`onInitiate()`
- 运行时控制：反向钩子装饰器，例如 `@ToolUse`、`@StepFinish`

模板相关的当前事实：

- 调试器真正加载的是可执行的 `.render.js`
- `getPackageInfo()` + `getTemplateNames()` 注册的模板会生成 `/template/...` URL
- 当宿主是 `AgentDevClaw` 时，runtime 会基于 `featureTemplates + projectRoot` 提供 `/features/*` 和 `/tools/*`
- 因此最稳妥的做法仍然是确保构建产物里的 `.render.js` 存在且可直接执行

项目内已经有一个实用 skill：

- `.agentdev/skills/agentdev-feature-guide`

它更适合让 agent 在当前代码库里直接写或改 Feature。

另外，仓库里现在提供了一个可编译的标准骨架：

- `src/features/example-feature`

它不是业务功能，而是”照猫画虎用”的最小完整示范，展示了：

- `getTools()`
- `getPackageInfo()` + `getTemplateNames()`
- `getContextInjectors()`
- `onInitiate()` / `onDestroy()`
- `captureState()` / `restoreState()`
- `beforeRollback()` / `afterRollback()`
- `@CallStart` / `@ToolUse` / `@StepFinish`

如果你要新建 Feature，建议先从这里复制，再删掉不需要的部分。

## 常用命令

```bash
npm run build
npm test
npm run server
npm run agt
npm run ragt
npm run qqbot
npm run dev
npm run claw:agent
npm run claw:ragent
npm run claw:qqbot
npm run claw:verify
npm run claw:verify:input
```

## 测试约定

测试运行器会执行：
- `src/test/**/*.test.ts` — 核心框架测试
- `src/features/*/test/**/*.test.ts` — Feature 级测试

所有测试必须使用标准错误处理模式：

```typescript
async function main(): Promise<void> {
  // 测试逻辑
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
```

## 文档分工

- `README.md`: 快速上手和整体认知
- `CLAUDE.md`: 隐式契约、架构边界、易误判的实现事实
- `.agentdev/skills/agentdev-feature-guide`: 如何在当前代码库里高效写 Feature

## 许可证

MIT
