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

### 3. 编译

```bash
npm run build
```

这是必需步骤。调试器加载的模板文件来自编译后的 `.render.js`。

### 4. 启动调试器

```bash
npm run server
```

默认地址：

- Web UI: `http://localhost:2026`
- Debugger MCP: `http://localhost:2026/mcp`

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

### Debugger

调试器不是只看消息的前端。它维护独立的 session 状态，当前包含：

- Overview
- Features
- Reverse Hooks
- Logs
- MCP

### Debugger MCP

`ViewerWorker` 会把同一份调试状态通过 MCP 只读暴露出去，当前内置：

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
- 注册模板：`getTemplatePaths()`
- 初始化资源：`onInitiate()`
- 运行时控制：反向钩子装饰器，例如 `@ToolUse`、`@StepFinish`

项目内已经有一个实用 skill：

- `.agentdev/skills/agentdev-feature-guide`

它更适合让 agent 在当前代码库里直接写或改 Feature。

## 常用命令

```bash
npm run build
npm test
npm run server
npm run agt
npm run dev
```

## 文档分工

- `README.md`: 快速上手和整体认知
- `CLAUDE.md`: 隐式契约、架构边界、易误判的实现事实
- `.agentdev/skills/agentdev-feature-guide`: 如何在当前代码库里高效写 Feature

## 许可证

MIT
