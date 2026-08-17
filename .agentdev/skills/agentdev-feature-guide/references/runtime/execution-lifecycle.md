# 生命周期、装配与扩展边界

## 目录

- [三个层级](#三个层级)
- [Feature 准备阶段](#feature-准备阶段)
- [一次 Call 的执行顺序](#一次-call-的执行顺序)
- [Agent 正向钩子与 Feature 反向钩子](#agent-正向钩子与-feature-反向钩子)
- [资源生命周期](#资源生命周期)
- [Feature 之间的协作](#feature-之间的协作)
- [继承现有 Feature](#继承现有-feature)
- [动态挂载和移除](#动态挂载和移除)
- [路径边界](#路径边界)

## 三个层级

AgentDev 的运行循环分为：

```text
Call：一次完整用户输入到最终输出
└── Step：一次 ReAct 迭代
    └── Tool：一次具体工具执行
```

对应职责：

- Call 处理输入改写、最终结果、会话级状态。
- Step 处理每轮 LLM 调用前后的提醒和继续/结束判断。
- Tool 处理参数校验、权限、执行、结果记录和中断。

不要用消息数量推断 call 或 step。上下文中可能有多个 system、assistant 和 tool 消息。

## Feature 准备阶段

Feature 通过 `agent.use(feature)` 注册。工具和生命周期准备通常在第一次 `onCall()` 或 `withViewer()` 前完成。

对每个 Feature，Agent 按顺序执行：

1. `getTools()`；
 2. `getAsyncTools(ctx)`；
 3. `onInitiate(ctx)`；
 4. 收集 `static hooks` 声明的反向钩子。

全部 Feature 完成后，Agent 子类的 `onFeatureToolsReady()` 执行。

由此得到几条实践规则：

- `getTools()` 创建的工具可以通过闭包读取 Feature 实例，但不要依赖尚未初始化的外部资源。
- 异步工具需要的连接可在 `getAsyncTools()` 中建立。
- 同步工具依赖的连接可在 `onInitiate()` 建立，但工具只会在初始化完成后的 call 中执行。
- 反向 hook 在 `onInitiate()` 之后进入 registry。
- `static inject` 声明决定初始化顺序（依赖先于依赖方）；无依赖声明时保持装配顺序。Feature 装配顺序决定工具覆盖顺序和 hooks 执行顺序。

## 一次 Call 的执行顺序

简化顺序：

```text
ensure Feature tools/resources/hooks
Agent.onCallStart (forward)
Agent.onInitiate (first call only)
resolve system prompt (first call only)
CallStart hooks
inject final user input

repeat Step:
  Agent.onStepStart (forward)
  StepStart hooks
  LLM chat
  Agent.onStepFinished (forward)
  if tools exist:
    ToolUse guards / execute / ToolFinished hooks
  StepFinish guard decision

Agent.onCallFinish (forward)
CallFinish hooks
```

几个关键边界：

- CallStart 钩子在系统提示词建立后、用户消息正式加入 Context 前执行。
- StepStart 钩子在本 step 的 LLM 调用前执行。
- ToolUse guard 在工具调用前执行，并可以阻止调用。
- ToolFinished 钩子在成功、失败、被禁用或被拦截后都会收到结果通知。
- CallFinish 钩子同时覆盖成功、异常、中断和 continuation 等结束原因。

## Agent 正向钩子与 Feature 反向钩子

### Agent 子类的正向钩子

自定义 Agent 的整体策略使用：

- `onInitiate`
- `onDestroy`
- `onCallStart`
- `onCallFinish`
- `onStepStart`
- `onStepFinished`
- `onToolUse`
- `onToolFinished`
- `onInterrupt`
- `onFeatureToolsReady`

这些方法适合：

- 定义整个 Agent 的运行策略；
- 注册不属于某个 Feature 的统一工具；
- 在所有 Feature 工具完成后覆盖同名工具；
- 连接 Agent 外层的调用仲裁或会话保存逻辑。

### Feature 的运行入口

Feature 使用：

- `onInitiate()` / `onDestroy()` 管理自身资源；
- `static hooks` 声明的 CallStart、CallFinish、StepStart、StepFinish、ToolUse、ToolFinished、ToolResultTransform 钩子参与运行循环。

不要在 Feature 中仅声明一个普通 `onStepStart()` 方法并期待它被当作钩子——没有进 `static hooks` 的方法不会被调用。

## 资源生命周期

Feature 的资源应由 Feature 自己拥有：

```ts
class RemoteFeature implements AgentFeature {
  readonly name = 'remote';
  private client?: RemoteClient;
  private abortController?: AbortController;

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.client = await RemoteClient.connect(parseConfig(ctx.featureConfig));
    this.abortController = new AbortController();
    void this.poll(this.abortController.signal);
  }

  async onDestroy(): Promise<void> {
    this.abortController?.abort();
    await this.client?.close();
    this.client = undefined;
  }
}
```

要求：

- 初始化方法可清晰失败或降级。
- 清理方法可重复调用。
- 后台循环能通过 signal 结束。
- 清理时等待需要有序关闭的资源。
- 外部资源不进入 `captureState()`。

## Feature 之间的协作

通过小型公开 API 协作：

```ts
export interface SearchIndexApi {
  search(query: string): Promise<SearchHit[]>;
}

class SearchFeature implements AgentFeature {
  readonly name = 'search';
  static inject = ['search-index'];
  private index?: SearchIndexApi;

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    const index = ctx.getFeature<AgentFeature & SearchIndexApi>('search-index');
    if (!index) throw new Error('search-index feature is required');
    this.index = index;
  }
}
```

`static inject` 声明依赖关系并由装配层拓扑排序（依赖先初始化，缺失即启动错误），`ctx.getFeature()` 完成运行时解析。

公开 API 应：

- 返回值或只读视图，不返回内部可变集合；
- 保持命名清晰；
- 不要求调用者理解内部存储；
- 对资源尚未准备的情况给出明确错误。

## 继承现有 Feature

当已有 Feature 的能力范围正确，只需增加少量策略时，可以继承。

### 扩展普通方法

```ts
class AuditedQueueFeature extends QueueFeature {
  override enqueue(value: string): string {
    const id = super.enqueue(value);
    this.audit(id, value);
    return id;
  }
}
```

### 扩展钩子方法

如果父类已声明一个 StepFinish 钩子方法，覆盖相同方法名并调用 `super`（`static hooks` 声明从父类继承，无需重写）：

```ts
import { Decision, type StepFinishDecisionContext } from 'agentdev';

class StopAwareTodoFeature extends TodoFeature {
  override async recordToolUsage(ctx: StepFinishDecisionContext) {
    const parentDecision = await super.recordToolUsage(ctx);
    if (this.shouldStop()) return Decision.Deny;
    return parentDecision;
  }
}
```

Hooks registry 记录的是方法名，运行时在子类实例上调用被覆盖的方法。子类需要新增钩子时，在子类 `static hooks` 中展开父类声明再补充，避免父类钩子静默丢失。

### 包装状态契约

需要为已有 Feature 增加额外快照字段时：

```ts
class TaggedFeature extends BaseFeature {
  private tag: string | null = null;

  override captureState() {
    return { ...super.captureState() as object, tag: this.tag };
  }

  override restoreState(snapshot: unknown): void {
    super.restoreState(snapshot);
    const state = snapshot as { tag?: unknown } | null;
    this.tag = typeof state?.tag === 'string' ? state.tag : null;
  }
}
```

始终保留父类的状态语义；不要只恢复新增字段。

## 动态挂载和移除

运行前静态装配：

```ts
agent.use(new SearchFeature());
```

运行时装配：

```ts
await agent.mountFeature(new SearchFeature());
```

运行时移除：

```ts
agent.removeFeature('search');
```

动态行为需要注意：

- Agent 已完成准备时，`mountFeature()` 立即初始化工具、资源和 hooks；首次 call 前调用时，初始化会延后到统一准备阶段。
- 移除会删除已知同步工具和 hooks，并触发 `onDestroy()`。
- Feature 若注册了异步工具、额外动态工具或后台资源，应提供自己的清理与注册追踪，确保移除后不残留。
- `removeFeature()` 是同步 API，不等待异步 `onDestroy()` 完成。必须确认资源已释放后才能继续的 Feature，应先调用自身可等待的公开停止方法，再执行移除。
- 不要通过重复 `use()` 在已运行 Agent 中替换同名 Feature；使用明确的移除和挂载流程。
- 配置改变后需要重建资源时，优先替换 Feature 实例，不要让一半旧配置和一半新配置共存。

## 路径边界

`AgentConfig` 中两个路径承担不同职责：

- `workspaceDir`：用户正在操作的工作目录。文件工具、相对路径、工作区配置和 `.agentdev` 内容以它为基准。
- `projectRoot`：Agent 应用的项目根目录。包解析、模板交付和调试宿主资源以它为基准。

Feature 构造函数可以接收显式路径，并在 `onInitiate(ctx)` 中用 `ctx.config` 补齐：

```ts
const workspaceDir = this.options.workspaceDir
  ?? ctx.config.workspaceDir
  ?? process.cwd();
```

避免在多个方法中随意读取 `process.cwd()`。进程工作目录可能不是用户工作区，也可能不是包根目录。
