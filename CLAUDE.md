# CLAUDE.md

This file is for work inside this repository. It is not meant to restate obvious code; it exists to capture the boundaries, contracts, and architectural intent that are easy to miss if you only skim files.

## Local Working Rules

永远不要用 `sed`、`cat`、`head`、`tail`、`grep`、`awk` 去读写文件。  
优先使用 Read / Glob / Edit / Write；在 Codex 环境里，读文件可用 shell，但写文件仍应通过补丁工具完成。

## Commands

```bash
npm run build
npm test
npm run agt
npm run ragt
npm run qqbot
npm run agent
npm run server
npm run dev
npm run claw:agent
npm run claw:ragent
npm run claw:qqbot
npm run claw:verify
npm run claw:verify:input
node scripts/build-and-pack-features.mjs
```

最后一条批量构建 + 打包全部 feature 包并把 tgz 直接落到 `../AgentDevClaw/resources/features/`。任何一个包失败都会以非零退出码结束。

## What This Project Is Optimizing For

AgentDev 不是“再包一层工具调用”的项目。它的主目标是：

- 让 agent 能以 Feature 为单位组织能力，而不是堆工具
- 让运行时结构可观察，而不是只看最终消息
- 让调试状态能被人类 UI 和外部 agent 以同一份数据消费

理解这三个目标之后，很多实现选择会更自然：

- 为什么 Feature 比裸工具重要
- 为什么 hook / feature / tool / log 都在做结构化快照
- 为什么调试器同时提供 Web UI 和只读 MCP

## Core Contracts

### 0. `projectRoot` 和 `workspaceDir` 不是一回事

这两个路径现在必须明确区分：

- `projectRoot`: 给调试器宿主、模板解析、包解析用
- `workspaceDir`: 给实际工具执行、相对路径解析、工作区语义用

不要再把“当前进程 cwd”同时拿来做这两件事。

当前约定：

- `ViewerWorker` / `Claw runtime` 解析 `/template/...`、`node_modules/...` 时，应该锚定 `projectRoot`
- `ShellFeature`、`OpencodeBasicFeature`、`MemoryFeature` 这类面向工作区的能力，应该显式使用 `workspaceDir`
- 如果某个 Feature 真要读工作目录下的 `CLAUDE.md`、`.trash`、相对文件路径，不要隐式依赖全局 `process.cwd()`

一句话：

- 资源定位看 `projectRoot`
- 用户当前正在操作什么目录看 `workspaceDir`

### 1. Context 不是日志缓冲区

`Context` 只负责对话消息和 message-like 注入。运行时日志是另一条独立通路。

不要：

- 把调试日志塞进 `context.add(...)`
- 指望 `query_logs` 能从消息里补全数据

要记住：

- 消息用于 LLM 推理链路
- 日志用于调试、筛选、诊断
- 两者故意分开

### 2. Feature 是能力包，不是工具目录

一个 Feature 的合理内容通常是：

- 工具
- 模板
- 少量内部状态
- 上下文注入
- 初始化资源
- 反向钩子

如果你看到一个“Feature”只有很多互不相关的工具，通常边界没立住。

### 3. Feature 的主运行时入口是反向钩子，不是 Agent 正向钩子

这是当前实现最容易被误读的地方。

`Agent` 子类的正向钩子：

- `onCallStart`
- `onCallFinish`
- `onStepStart`
- `onStepFinished`
- `onToolUse`
- `onToolFinished`

Feature 更稳定的扩展面：

- `getTools`
- `getAsyncTools`
- `getTemplatePaths`
- `getContextInjectors`
- `onInitiate`
- `onDestroy`
- `captureState`
- `restoreState`
- `beforeRollback`
- `afterRollback`
- 反向钩子（`static hooks` 静态声明，见下）

如果你在 Feature 里直接实现一堆正向钩子同名方法，先怀疑自己走错入口了。

### 4. 反向钩子的唯一契约是 `static hooks` 静态声明

Feature 参与运行循环（call / step / tool 边界）不使用装饰器，也没有方法名约定。唯一注册路径：

```typescript
class MyFeature implements AgentFeature {
  static hooks: HookDeclarations = {
    beforeTool: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard', role: 'policy' },
    onStepStart: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' },
  };
}
```

三条规则：

- 没有声明 = 没有钩子。方法写了但没进 `static hooks`，永远不会被调用。
- kind 由作者声明：`observe`（任意生命周期，返回值丢弃）/ `guard`（仅 ToolUse、StepFinish，返回 Decision）/ `transform`（仅 ToolResultTransform，链式改写结果）。
- guard 的 `role: 'policy'` 每个生命周期至多一个，多出的在装配时报错；advisor 是默认角色。

工具是否允许执行（ToolUse guard）和 call 是否继续下一轮（StepFinish guard）是仅有的两个流程控制位。如果需要多个判断，在同一个方法里组合。

依赖声明同理走静态属性：`static inject = ['other-feature']`，装配时拓扑排序，缺失依赖 / 循环依赖 / 重名是启动错误。

详细语义、错误码对照和示例见 `.agentdev/skills/agentdev-feature-guide/references/runtime/reverse-hooks-reference.md`。

### 5. Tool context 不是天然全知的

工具签名虽然是 `execute(args, context?)`，但第二参数里没有统一默认注入的 `agent` 或 `feature` 对象。它主要来自 `getContextInjectors()`。

因此：

- 不要假设 `context.agent` 一定存在
- 不要把 `getAsyncTools()` 当成获取全部内部对象的后门
- 如果某个工具需要运行时上下文，应该显式设计注入结构

### 6. 模板系统是运行时能力的一部分，不是装饰层

Feature 工具如果长期存在，通常应一起提供模板。  
模板加载链路依赖：

- 工具 `render`
- Feature `getTemplatePaths()`
- 构建产物中的 `.render.js`

Feature 模板必须 `export default`。系统模板才是 `TEMPLATES`。

当前还要记住两点：

- `Agent` 会把 `getTemplatePaths()` 收集到 `featureTemplates`，再随调试 session 一起发给 debugger host
- 独立 `Claw runtime` 会基于 `featureTemplates + projectRoot` 去解析 `/features/*` 和 `/tools/*`，因此“可执行的 `.render.js` 构建产物”仍然是最可靠目标

### 7. Debugger 的 Web UI 和 MCP 必须读同一份状态

这是当前调试架构的核心约束。

当前的 debugger host 可以是：

- 旧的 `ViewerWorker`
- 独立的 `Claw runtime`

无论具体宿主是谁，它都必须同时服务：

- Web UI 的数据提供者
- 调试 MCP 的只读数据提供者

不要引入一份“只给 MCP 用”的第二套调试状态。现在这套架构刻意避免了数据源漂移。

### 8. LLM 内核语义以 OpenAI 风格消息模型为准

当前框架内部仍然只维护一套主消息语义：

- `system`
- `user`
- `assistant`
- `tool`
- `assistant.toolCalls`
- `assistant.reasoning`

Anthropic 不是第二套内核，而是边界层编译目标。不要把 Anthropic 的 block 结构、顶层 `system`、`tool_use`、`tool_result` 直接泄漏进 Feature 或 Core 主流程。

### 9. Anthropic 的 `system` 和 runtime reminder 必须分层

这是当前最容易做错的地方。

编译规则已经明确：

- 首个 `user` 之前的所有 `system` 消息：编译到 Anthropic 顶层 `system[]`
- 首个 `user` 之后再出现的 `system` 消息：视为动态 reminder，降级成 `<reminder>...</reminder>` 文本块，注入后续 `user.content[]`

不要把所有 `system` 一律提升到 Anthropic 顶层，也不要把动态 reminder 混进固定 system。

原因：

- 前缀 system 更像 agent 宪法
- 后续 reminder 更像当前轮输入的一部分
- 这样才能稳定利用 Anthropic 的 prompt caching 和 context management

### 10. Anthropic thinking 是 block + signature，不只是 reasoning 文本

当前实现里，Anthropic 开启 thinking 后，不仅会保留 `reasoning` 文本，还会在消息里存储 `thinkingBlocks`：

- `thinking`
- `signature`

这不是多余字段。Anthropic 在保留连续思维时，需要把最近历史里的 thinking block 原样回放给下一轮请求。

因此：

- 如果你改 `Message` / `LLMResponse` / `Context`，不要丢掉 `thinkingBlocks`
- 如果你改 Anthropic stream 解析，必须同时处理 `thinking_delta` 和 `signature_delta`
- 如果你改 Anthropic 历史编译，assistant 历史里要优先回放 thinking block，再放 text / tool_use

### 11. Anthropic 连续思维依赖 context management beta

当前“保留最近几轮 thinking”的实现，不是伪造一个自定义字段，而是依赖 Anthropic 的 beta context management：

- `anthropic-beta: context-management-2025-06-27`
- `context_management.edits = [{ type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: N } }]`

启用条件：

- 配置了 `thinkingBudgetTokens >= 1024`
- `thinkingKeepTurns > 0`

默认：

- `thinkingKeepTurns = 5`

如果以后兼容端点不支持这个 beta，应该在 Anthropic adapter 边界降级，不要把这套细节扩散到别处。

### 12. Step rollback 和 session restore 是同一套快照语义

当前实现里：

- 每个 step 开始前创建 step checkpoint
- step 内异常时回滚到这个 checkpoint
- 每个成功 call 完成后记录一个 pre-call checkpoint
- 会话恢复时，新 Agent 会恢复到保存下来的 runtime checkpoint

不要把“恢复会话”理解成复活旧进程。  
它更接近：

1. 启动一个全新 Agent
2. 让 Feature 完成正常初始化
3. 再恢复 `Context` 和已声明的 Feature 状态

也就是说：

- rollback: in-process 回退
- session restore: cross-process 恢复
- 共享同一套 snapshot 设计

### 13. Feature 需要自己声明哪些状态可恢复

框架当前不会扫描字段自动推断状态。

要恢复的状态，必须由 Feature 自己显式声明：

- `captureState()`
- `restoreState()`

如果一个 Feature 只有可重建资源，没有真正需要跟着 checkpoint 回退的内存状态，可以不实现这套接口。

不要把这条理解成“所有 Feature 都必须实现 rollback 支持”。  
更准确的规则是：

- 需要状态一致性时再实现
- 不需要时宁可不写，也不要为了形式统一造假快照

如果一个 Feature 同时有：

- 内存逻辑状态
- 外部连接 / worker / 子进程

则应分开处理：

- 内存状态进入 snapshot
- 外部资源在新实例中重建，或显式降级

### 14. 不要伪造外部运行态恢复

这是当前 Feature 设计里非常重要的边界。

例如：

- MCP 连接
- crawl4ai client
- QQBot gateway
- 子代理运行池
- 视觉监控 worker / cache manager

这些都不是“对象序列化后原样回来”的东西。

当前推荐原则：

- 可以重建的资源：在初始化后重建
- 不能安全恢复的运行态：明确清空或降级

`SubAgentFeature` 现在就是这个策略的示范：

- 不伪造恢复活跃子代理
- 恢复时清空 live runtime
- 必要时打印明确 warning

### 15. Feature 快照必须是值快照，不是对象引用

这次 `todo` 的 rollback 问题暴露了一个很具体的约束：

- Feature 的 snapshot 不能依赖可变对象引用
- checkpoint 层会把 `FeatureStateSnapshot` 深拷贝后再保存/恢复

否则会出现：

- checkpoint 创建后
- 原对象继续被修改
- 恢复时“旧快照”也被污染

如果你以后改 checkpoint 或 Feature 恢复逻辑，不要破坏这个值快照语义。

## Debugger Architecture

运行时链路分三层：

1. Agent 本地运行时产生消息、工具状态、hook snapshot、log entry
2. `DebugHub` 负责把这些状态发给当前 debugger host
3. debugger host 维护多 agent session，并同时服务：
   - Web UI
   - `/mcp`

`DebugHub` 更像路由层，不是长期存储。  
当前承载层可以是：

- 本仓库里的 `ViewerWorker`
- `D:\code\AgentDevClaw` 里的独立 runtime / desktop host

新功能优先按“外部宿主可接入”的方向设计，不再默认把调试后端固化在 `AgentDev` 仓库里。

## Snapshot Semantics

最近几次提交把调试器从“看消息”推进到“看运行时结构”。

当前已有两类重要快照：

- hook / feature inspector snapshot
- tool registration snapshot

这些快照的设计原则是：

- 由 Agent 端从权威状态重新构建
- 发给 `DebugHub`，再转发到当前 debugger host
- 再由前端和 MCP 消费

如果未来新增调试字段，优先继续往 snapshot 里加，而不是让 UI 直接依赖内部 registry 或 feature 实例。

## Logging Semantics

这是当前最需要遵守的契约之一。

### 结构化日志的目标

日志系统要让 agent、前端、人类开发者都能明确知道：

- 这条日志属于哪个 agent / step / tool / feature / hook
- 它是否进入了 debugger hub
- 如果没进，是因为本地回退，而不是神秘消失

### 当前规则

- `createLogger()` / `runWithLogScope()` 是主路径
- `console.*` bridge 是兼容层，不是最终主入口
- 当存在 `agentId` 且 DebugHub 已连接时，日志进入 hub
- 当存在 `agentId` 但 DebugHub 不可用时，日志回退到本地 console
- `query_logs` 只返回成功送达 hub 的日志

这意味着：

- Hub/MCP 里的日志是“已收集日志”，不是“进程里发生过的一切”
- 本地 fallback 日志必须保持可读，让人知道它为什么没有出现在 MCP 结果里

如果你修改日志相关代码，不要再把系统拉回“有些进 Hub，有些静默丢失”的状态。

### 当前已显式化的交付语义

`DebugLogEntry` 带有 `delivery` 元数据。它至少回答三个问题：

- 是否进了 hub
- 是否写回本地 console
- 原因是什么

这是为了让调试器、MCP 和未来的诊断流程能诚实表达“我们看到了什么，没看到什么”。

## Debugger MCP

当前内置调试 MCP 不是通用控制面，而是只读观察面。

它提供：

- Tools：面向参数化查询
- Resources：面向稳定快照读取
- Prompts：面向直接让另一个模型消费调试上下文

这三类能力同时存在不是重复，而是刻意分工：

- tool: 查
- resource: 读
- prompt: 分析

如果未来要做反向控制，应新增正式 command channel，而不是偷偷把写操作塞进只读调试 MCP。

当 transport 切到 `claw` 时，这个只读观察面由独立 `Claw runtime` 提供；当 transport 仍是默认模式时，则由本地 `ViewerWorker` 提供。语义应保持一致，差异只允许出现在 transport 和宿主进程层。

## MCP Layering

MCP 在这个仓库里有三个层次：

1. `src/mcp/*`
   - 协议原语、连接、发现、受管装配
2. `MCPFeature`
   - 最小便利封装，主要负责快速挂载 `.agentdev/mcps`
3. 业务 Feature 内部自带 MCP
   - 例如按领域把某个 server 包装成稳定工具集合

一般推荐：

- 通用接入：用 `MCPFeature`
- 领域能力：Feature 内部直接接管 MCP，并做 rename / disable / describe / render

如果某个业务 Feature 已经内部接管某个 MCP server，记得用 `excludeMcpServers` 避免全局再挂一遍。

## Things That Are Easy To Misread

### 1. `getAsyncTools()` 不是“拿到 Agent 后随便操作”的入口

它是异步准备工具的入口。能用的最关键对象通常是：

- `config`
- `featureConfig`
- `getFeature()`
- `registerTool()`
- `logger`

### 2. `Call` 和 `Step` 不一样

- `Call`: 用户的一次完整输入输出
- `Step`: 一次 ReAct 迭代

不要把 `callIndex` 当成 step，也不要把 step 当成消息轮数。

### 3. `CallStart` 发生在用户消息真正注入前

这就是它适合改写输入缓存的原因。  
如果你想做 slash command、模式切换、输入重写，先想 CallStart 钩子。

### 4. Debugger 当前没有正式的通用反向控制面

已有一条反向链路用于 user input 请求响应，但那不等于已经存在完备的“前端控制 agent”协议。

如果以后加 feature enable/disable、pause、resume 之类的控制，应设计明确消息类型，不要滥用现有输入回传机制。

### 5. OpenAI 和 Anthropic 的 thinking 控制方式不一样

不要假设有一套统一的“思考模式开关”。

当前约定是：

- OpenAI 路径：通过 `defaultModel.providerOptions` 透传 provider 私有参数
- Anthropic 路径：通过 `thinkingBudgetTokens` 和 `thinkingKeepTurns` 控制

也就是说，OpenAI 世界没有被框架强行抽象成一个统一 reasoning API；Anthropic 也没有被硬塞进 OpenAI 的字段形状里。

## Testing Rules

### 1. Feature 测试必须写在 Feature 内部

Feature 的测试文件位于 `src/features/your-feature/test/`，与 Feature 源码同目录。

测试运行器自动发现：
- `src/test/**/*.test.ts` — 核心框架契约测试
- `src/features/*/test/**/*.test.ts` — Feature 级测试

### 2. 测试文件必须使用标准错误处理模式

所有测试必须使用 `main().catch()` 模式：

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

不使用此模式的测试在失败时不会正确退出进程，导致测试运行器阻塞。

## Feature 包构建与打包

修改 `packages/<name>-feature/` 后的交付链是五步：构建 → 打包 → 验证 → 同步 → 重装。完整规范见 `.agentdev/skills/agentdev-feature-packaging/SKILL.md`，这里只列最容易出错的边界：

- 包内构建只用 `npm run build`（= `tsup && copy-assets`）。裸 `npx tsup` 会跳过 copy-assets，产出缺静态资源（mp3 / 模板 / skills）的 dist。
- `npm pack` 不打包空目录，构建产物里缺失的资源打包后无法找回。打包后必须 `tar tzf` 核对清单。
- 双路径 feature（同时存在于 `packages/<name>-feature/` 和 `src/features/<name>/`）：两侧源码都要改、两个构建都要跑。当前包括 shell、audit、audio-feedback、memory、qqbot、tts、visual、websearch、plugin-compat。
- tgz 不是交付终点：复制到 `../AgentDevClaw/resources/features/` 后，还要处理 package-lock integrity（file: 依赖通常直接删包重装 `npm install`），并验证 `node_modules` 中代码与资源已就位。

## Where To Look Next

如果你是在写或改 Feature，不要先扩写这里。
先看：

- `.agentdev/skills/agentdev-feature-guide/SKILL.md`
- `.agentdev/skills/agentdev-feature-guide/references/runtime/reverse-hooks-reference.md`
- `.agentdev/skills/agentdev-feature-guide/references/quality/troubleshooting.md`
- `.agentdev/skills/agentdev-feature-packaging/SKILL.md`
- `src/features/example-feature`
