---
name: agentdev-feature-guide
description: AgentDev Feature 的完整设计、实现、扩展、测试、审查与排障规范。用于划分 Feature 能力边界，设计工具契约和公开 API，处理异步发现、MCP、上下文注入、生命周期资源、并发中断、配置 manifest、反向钩子、状态恢复、动态装配、渲染、Feature 自带技能、安全、可观测性及交付验收。
---

# AgentDev Feature 开发指南

把 Feature 理解为 AgentDev 的“能力单元”：它向 Agent 提供一组内聚的工具、运行时行为、配置和状态契约。Agent 负责一次 call 的完整执行循环；Feature 负责把某个领域能力接入这个循环。

## 先建立心智模型

一项能力通常由以下部分组成：

- `getTools()`：同步声明工具。
- `getAsyncTools(ctx)`：连接、发现或异步构造工具。
- `getContextInjectors()`：向匹配的 `tool.execute(args, context)` 注入运行时值。
- `onInitiate(ctx)` / `onDestroy(ctx)`：创建和释放运行时资源。
- 反向钩子：在 call、step、tool 边界参与处理或决策。
- `getFeatureManifest()`：声明项目级配置表面。
- `captureState()` / `restoreState()`：声明可回滚、可恢复的逻辑状态。
- `getPackageInfo()` / `getTemplateNames()`：交付查看器渲染模板。
- `skills/`：随 Feature 一起提供给 Agent 的使用知识。

只实现任务需要的部分。一个无状态工具 Feature 不需要快照；一个纯 hook Feature 不需要工具；一个没有自定义展示的 Feature 不需要模板。

## 按任务选择阅读路径

先判断本次只涉及 Feature 内核，还是已经需要 standalone Agent 装配；不要为了一个工具 Feature 通读所有体验面专题。

| 当前任务 | 先读 |
|---|---|
| 纯工具、参数/结果契约 | 本文“选择入口” + [工具契约设计](references/tools/tool-contracts.md) + [Feature 单元测试](references/quality/unit-testing.md) |
| Hook、继续/结束控制 | [反向 Hook 参考](references/runtime/reverse-hooks-reference.md) + [Hook 规则设计](references/runtime/hook-design.md) |
| 会话状态、checkpoint、rollback | [状态快照与恢复](references/runtime/state-recovery.md) + [Agent 集成与交付测试](references/quality/integration-testing.md) |
| client、轮询、子进程或中断 | [初始化、就绪状态与资源清理](references/runtime/resource-management.md) + [并发、中断与幂等](references/tools/concurrency-cancellation.md) |
| 配置 UI、模板或 Feature 自带技能 | 对应 experience 专题；没有明确需求时不要预先实现 |
| npm 包交付 | `agentdev-feature-packaging` + [Agent 集成与交付测试](references/quality/integration-testing.md) |
| standalone Agent 装配 | `agentdev-agent-assembly`；这不是普通 Feature 内核验证 |

本指南优先覆盖 Feature 内核与其 standalone 消费契约。HTTP、前端面板、session IPC、prebuilt/built-in runtime 属于产品宿主集成，不要假设它们会由 Feature Test Runtime 覆盖。若任务确实跨到这些层而手册尚无对应章节，读取相关实现定位，并把可复用契约回填为手册和回归测试。

## 工作顺序

1. 确定能力边界：用一句话说明 Feature 为 Agent 提供什么能力。
2. 定义公开契约：确定工具、配置项、其他 Feature 可调用的小型公开 API。
3. 选择运行入口：静态工具、异步工具、上下文注入、反向钩子或生命周期方法。
4. 划分状态：区分逻辑状态、缓存和外部运行时资源。
5. 设计 Agent 可理解的工具名、描述、参数和错误结果。
6. 按执行语义标记工具：普通、独占或可并发。
7. 需要人类配置时声明 manifest，并在 `onInitiate(ctx)` 中解析 `ctx.featureConfig`。
8. 需要展示时选择内联模板或包模板。
9. 需要配套知识时在 Feature 中提供 `skills/`。
10. 用项目采用的测试框架验证工具、hooks、配置和状态恢复。

每个阶段必须留下可检查产物：

| 阶段 | 产物 |
|---|---|
| 设计 | 一句话边界、非目标、能力清单、风险清单 |
| 契约 | 工具 schema/结果、公开 API、配置优先级、状态分类 |
| 实现 | Feature 装配、领域服务、资源所有权、错误策略 |
| 运行控制 | hook 决策表、并发/独占、中断、continuation |
| 恢复 | snapshot schema、外部副作用说明、迁移与往返测试 |
| 交付 | 模板、skills、构建资源、消费 smoke test |
| 验收 | 单元/集成/安全测试、inspector 对账、审查清单 |

## 选择入口

| 需求 | 使用方式 |
|---|---|
| 工具在构造时即可确定 | `getTools()` |
| 工具依赖连接、探测或远端发现 | `getAsyncTools(ctx)` |
| 工具需要 Feature 状态或专用运行时对象 | `getContextInjectors()` |
| Feature 需要客户端、轮询器或其他资源 | `onInitiate()` / `onDestroy()` |
| 改写当前输入 | `static hooks` 声明 CallStart 钩子 + `ctx.agent.getUserInput()/setUserInput()` |
| 每个 ReAct step 前注入提醒 | `static hooks` 声明 StepStart 钩子 |
| 工具执行前校验或阻止 | `static hooks` 声明 ToolUse guard 钩子 |
| 工具完成后记录或同步 | `static hooks` 声明 ToolFinished 钩子 |
| 无工具调用时仍需继续或主动结束 call | `static hooks` 声明 StepFinish guard 钩子 |
| 按 call 结束原因处理结果 | `static hooks` 声明 CallFinish 钩子 + `ctx.finishReason` |
| 工具结果写入 Context 前截断或脱敏 | `static hooks` 声明 ToolResultTransform 钩子 |
| 让配置 UI 发现 Feature 设置 | `getFeatureManifest()` |
| 让状态跟随 checkpoint 和 session | `captureState()` + `restoreState()` |

反向钩子的完整语义、三原语、guard 角色和错误码对照：读 [反向 Hook 参考](references/runtime/reverse-hooks-reference.md)。

## 最小实现

```ts
import type { AgentFeature, FeatureInitContext, Tool } from 'agentdev';
import { createTool } from 'agentdev';

export class NotesFeature implements AgentFeature {
  readonly name = 'notes';
  readonly description = '记录并读取当前会话中的简短笔记。';

  private notes: string[] = [];
  private logger?: FeatureInitContext['logger'];

  getTools(): Tool[] {
    return [
      createTool({
        name: 'note_add',
        description: '添加一条会话笔记。需要在用户明确要求记录信息时调用。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要记录的笔记正文。' },
          },
          required: ['text'],
        },
        execute: async ({ text }) => {
          const value = String(text).trim();
          if (!value) return { ok: false, error: 'text 不能为空' };
          this.notes.push(value);
          return { ok: true, count: this.notes.length };
        },
      }),
    ];
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger.info('Notes feature initiated');
  }

  captureState() {
    return { notes: [...this.notes] };
  }

  restoreState(snapshot: unknown): void {
    const state = snapshot as { notes?: unknown[] } | null;
    this.notes = Array.isArray(state?.notes)
      ? state.notes.filter((item): item is string => typeof item === 'string')
      : [];
  }
}
```

如果不需要状态恢复，删除 `captureState()` 和 `restoreState()`；如果不需要初始化日志，删除 `onInitiate()`。

## 必须遵守的原则

- 使用 `feature.name` 作为配置键、工具来源和跨 Feature 查找标识；保持名称稳定。
- 把工具描述写给 Agent 阅读，明确用途、调用条件、限制和返回结果。
- 让 `getTools()` 负责同步声明；把连接和发现放进 `getAsyncTools()` 或 `onInitiate()`。
- 通过 `ctx.featureConfig` 接收项目级配置；manifest 负责声明配置，不负责自动应用配置。
- 通过 `ctx.config.workspaceDir` 解释用户工作区路径；把 `projectRoot` 留给包和模板等项目资源定位。
- 只将纯数据放入 Feature 快照；客户端、socket、子进程、定时器和活动任务在初始化阶段重建。
- 将控制流工具标记为 `executionMode: 'exclusive'`。
- 只将彼此独立的只读操作标记为 `parallelizable: true`。
- 工具需要中断时读取 `context.signal`，并让底层操作真正响应 `AbortSignal`。
- 继承带钩子的 Feature 时，覆盖原钩子方法；需要新增钩子时在子类 `static hooks` 中展开父类声明再补充。
- 为可复用 Feature 提供小型公开 API；通过 `ctx.getFeature(name)` 读取，不共享内部可变对象。

## 参考模块

### 基础设计

- 开始新 Feature 或大改现有 Feature：读 [完整开发流程](references/foundation/development-workflow.md)。
- 判断能力是否应拆分、使用工具还是 hook：读 [能力边界与架构决策](references/foundation/architecture-boundaries.md)。
- 核对接口字段和装配入口：读 [Feature 模型与完整接口](references/foundation/feature-model.md)。
- 组织源码、类型和构建入口：读 [工程结构与 TypeScript 基线](references/foundation/project-structure.md)。
- 选择薄工具、领域服务、状态机、后台桥接等结构：读 [设计模式](references/foundation/design-patterns.md)。

### 工具

- 核对 `Tool`、同步/异步工具、执行上下文和 continuation：读 [工具运行模型](references/tools/tool-runtime.md)。
- 设计名称、描述、JSON Schema、结果和错误：读 [工具契约设计](references/tools/tool-contracts.md)。
- 处理同名覆盖、disabled、removed 和动态工具：读 [工具注册与可见状态](references/tools/tool-registry.md)。
- 向工具提供 Feature 运行时对象：读 [工具上下文注入](references/tools/context-injection.md)。
- 处理并发、独占、中断、超时、重试和副作用：读 [并发、中断与幂等](references/tools/concurrency-cancellation.md)。
- 连接、发现、筛选或改写 MCP 工具：读 [异步发现与 MCP 领域装配](references/tools/async-discovery-mcp.md)。

### 运行时

- 确认 call/step/tool 和 Feature 准备顺序：读 [执行生命周期](references/runtime/execution-lifecycle.md)。
- 查询每个 Feature hook 的上下文字段和 Decision 语义：读 [反向 Hook 参考](references/runtime/reverse-hooks-reference.md)。
- 组合规则、设计退出条件和处理 hook 异常：读 [Hook 规则设计与错误策略](references/runtime/hook-design.md)。
- 管理 client、socket、timer、worker 和后台 Promise：读 [初始化、就绪状态与资源清理](references/runtime/resource-management.md)。
- 使用 `static inject`、`getFeature()`、公开 API 或继承：读 [Feature 依赖与组合](references/runtime/composition.md)。
- 运行期安装、替换、禁用或移除 Feature：读 [动态挂载与替换](references/runtime/dynamic-mounting.md)。
- 实现 checkpoint、rollback 和 session restore：读 [状态快照与恢复](references/runtime/state-recovery.md)。

### 配置与体验交付

- 声明 manifest、解析配置、处理路径与重载：读 [Feature 配置与 Manifest](references/experience/configuration-manifest.md)。
- 为工具结果提供 HTML 展示：读 [工具渲染与模板交付](references/experience/rendering.md)。
- 教 Agent 使用多个相关工具：读 [Feature 自带 Skills](references/experience/feature-skills.md)。
- 设计结构化日志、readiness 和 inspector 诊断：读 [日志与运行诊断](references/experience/observability.md)。

### 质量保障

- 编写纯函数和 Feature 单元测试：读 [Feature 单元测试](references/quality/unit-testing.md)。
- 验证真实 Agent 循环、动态装配、恢复和打包消费：读 [Agent 集成与交付测试](references/quality/integration-testing.md)。
- 处理路径、网络、进程、凭据和 fail-closed：读 [Feature 安全设计](references/quality/security.md)。
- 提交验收前逐项检查：读 [Feature 代码审查与验收](references/quality/review-checklist.md)。
- 行为与预期不一致时：读 [Feature 排障清单](references/quality/troubleshooting.md)。

### 完整范例

- 纯工具或会话内状态：读 [无状态工具与可恢复状态](references/examples/stateless-stateful.md)。
- 动态发现、远端客户端和清理：读 [远端发现与可清理资源](references/examples/remote-discovery.md)。
- 安全准入、独占工具和 continuation：读 [安全策略与控制流工具](references/examples/policy-control.md)。

独立 npm 包的构建、资源复制和发布交给 `agentdev-feature-packaging` 技能处理。

## 完成检查

- Feature 名称、工具名称和模板名称互不混淆且保持一致。
- 工具参数使用清晰的 JSON Schema，并为字段提供 `description`。
- hooks 的返回类型符合其生命周期语义。
- 配置默认值在实现中真正被解析和应用。
- 快照恢复后，逻辑状态完整且外部资源可重新建立。
- 资源清理由 `onDestroy()` 完成，并可安全重复调用。
- 模板、skills 和其他非 TypeScript 资源进入构建产物。
- 测试覆盖最重要的成功路径、拒绝路径和恢复路径。
