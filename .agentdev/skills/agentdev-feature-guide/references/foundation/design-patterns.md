# Feature 设计模式

## 目录

- [能力包模式](#能力包模式)
- [薄工具与领域服务模式](#薄工具与领域服务模式)
- [公开 API 模式](#公开-api-模式)
- [配置声明与运行时解析模式](#配置声明与运行时解析模式)
- [异步发现模式](#异步发现模式)
- [领域 MCP 模式](#领域-mcp-模式)
- [提醒状态机模式](#提醒状态机模式)
- [控制流工具模式](#控制流工具模式)
- [Feature 模板方法模式](#feature-模板方法模式)
- [后台桥接模式](#后台桥接模式)
- [值快照与资源重建模式](#值快照与资源重建模式)
- [Feature 自带 Skill 模式](#feature-自带-skill-模式)
- [应避免的结构](#应避免的结构)

## 能力包模式

把同一领域的工具、状态、配置、hooks、模板和 skills 放在一个 Feature 中：

```text
record-feature/
├── src/
│   ├── index.ts
│   ├── service.ts
│   ├── tools.ts
│   ├── types.ts
│   └── templates/
├── skills/
└── test/
```

适合：

- 一组工具共享客户端和配置；
- 工具需要统一权限或审计 hook；
- Feature 有明确的一句话能力描述。

边界判断：删掉某个工具后，如果其余工具、状态和配置仍属于同一用户目标，通常边界合理。

## 薄工具与领域服务模式

工具负责 Agent 契约，领域服务负责业务逻辑：

```ts
class RecordService {
  constructor(private client: RecordClient) {}

  async update(id: string, patch: Record<string, unknown>) {
    // 业务校验、转换和 SDK 调用
  }
}

function createUpdateTool(service: RecordService): Tool {
  return createTool({
    name: 'record_update',
    description: '更新指定记录。',
    parameters: { /* ... */ },
    execute: async ({ id, patch }) => service.update(id, patch),
  });
}
```

收益：

- 工具 schema 与业务实现分离；
- 服务可被其他工具或公开 API 复用；
- 单元测试不必启动完整 Agent。

## 公开 API 模式

Feature 间协作时暴露最小接口：

```ts
export interface QueueFeatureApi {
  enqueue(text: string): string;
  list(): ReadonlyArray<{ id: string; text: string }>;
}

class QueueFeature implements AgentFeature, QueueFeatureApi {
  private items: Array<{ id: string; text: string }> = [];

  list() {
    return this.items.map(item => ({ ...item }));
  }
}
```

调用者在 `onInitiate(ctx)` 中解析：

```ts
this.queue = ctx.getFeature<AgentFeature & QueueFeatureApi>('queue');
```

不要暴露 `Map`、客户端或完整 runtime 对象。

## 配置声明与运行时解析模式

配置由三部分组成：

1. manifest 告诉配置宿主可以编辑什么；
2. `AgentConfig.features[feature.name]` 保存实际值；
3. `onInitiate(ctx)` 解析并应用 `ctx.featureConfig`。

```ts
getFeatureManifest(): FeatureManifestDefinition {
  return {
    schemaVersion: 1,
    settings: {
      properties: {
        enabled: { type: 'boolean', title: '启用', default: true },
        endpoint: {
          type: 'string',
          title: '服务地址',
          placeholder: 'https://api.example.com',
          showWhen: { property: 'enabled', values: [true] },
        },
      },
    },
  };
}

async onInitiate(ctx: FeatureInitContext): Promise<void> {
  const raw = ctx.featureConfig as Record<string, unknown> | undefined;
  this.enabled = raw?.enabled !== false;
  this.endpoint = typeof raw?.endpoint === 'string' ? raw.endpoint.trim() : '';
}
```

构造函数参数适合程序化装配；`featureConfig` 适合项目级配置。定义清晰的优先级，例如：显式构造参数 > featureConfig > manifest 默认值。

## 异步发现模式

远端能力列表决定工具集合时：

```ts
async getAsyncTools(ctx: FeatureInitContext): Promise<Tool[]> {
  this.client = await connect(this.options);
  const actions = await this.client.listActions();
  ctx.logger.info('Actions discovered', { count: actions.length });
  return actions.map(action => createActionTool(this.client!, action));
}
```

注意：

- 工具名需要确定性映射；
- 远端描述要改写成 Agent 可理解的用途说明；
- 过滤不安全或不需要的操作；
- 在 `onDestroy()` 关闭连接；
- 远端发现失败时给出明确日志或错误。

## 领域 MCP 模式

当 MCP server 只是领域能力的传输层，让业务 Feature 管理它：

```text
Feature
├── MCP config/client
├── discovery
├── rename / disable / describe
├── domain tools
├── render templates
└── lifecycle cleanup
```

这样 Agent 看到的是 `issue_search`、`issue_update`，而不是难以理解的原始 server 工具名。确保通用 MCP 自动装配不会再次挂载同一 server。

## 提醒状态机模式

适合待办、额度、审批、同步等需要周期性提醒的能力。

状态示例：

```ts
interface ReminderState {
  stepsSinceReminder: number;
  lastRevision: number;
  reminderPending: boolean;
}
```

流程：

1. ToolFinished 钩子观察相关工具是否改变状态；
2. StepFinish guard 更新计数并决定是否继续；
3. StepStart 钩子在需要时注入一次提醒；
4. `captureState()` 保存影响行为的计数和标志；
5. `restoreState()` 恢复完整状态机。

避免每个 step 无条件注入相同提示。提醒应由明确状态变化驱动。

## 控制流工具模式

控制工具不直接在工具执行栈中重建 runtime，而是登记 continuation：

```ts
createTool({
  name: 'phase_commit',
  description: '提交当前阶段并在新的 call 段继续。必须作为本轮唯一工具。',
  executionMode: 'exclusive',
  execute: async ({ phase }, context) => {
    context.registerContinuationRequest({
      kind: 'checkpoint',
      checkpointId: `phase:${phase}`,
      metadata: { phase },
    });
    return { ok: true, phase };
  },
});
```

调用方在 `onCall()` 返回后消费 request，并在 call 边界完成 checkpoint 或 rollback。这样工具结果、Context 和 Feature 快照保持一致。

## Feature 模板方法模式

需要为已有 Feature 增加横切能力时，用继承或高阶类包装：

```ts
type StatefulFeature = AgentFeature & {
  captureState(): unknown;
  restoreState(snapshot: unknown): void | Promise<void>;
};

type StatefulFeatureConstructor<T extends StatefulFeature = StatefulFeature> =
  new (...args: any[]) => T;

function withMetrics<TBase extends StatefulFeatureConstructor>(Base: TBase) {
  return class MetricsFeature extends Base {
    private calls = 0;

    override captureState() {
      const base = super.captureState();
      return { ...(base as object), metricsCalls: this.calls };
    }

    override async restoreState(snapshot: unknown): Promise<void> {
      await super.restoreState(snapshot);
      const state = snapshot as { metricsCalls?: unknown } | null;
      this.calls = typeof state?.metricsCalls === 'number' ? state.metricsCalls : 0;
    }
  };
}
```

适用条件：

- 基类能力边界仍然正确；
- 扩展只增加一个清晰维度；
- 能完整保留父类生命周期、hooks 和快照语义。

如果扩展需要大量访问父类私有细节，改用组合和公开 API。

## 后台桥接模式

Feature 可以连接外部事件源并在 step 边界注入消息：

```ts
class InboxFeature implements AgentFeature {
  private pending: string[] = [];
  private controller?: AbortController;

  async onInitiate(): Promise<void> {
    this.controller = new AbortController();
    void this.poll(this.controller.signal);
  }

  // static hooks: { remind: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' } }
  async injectMessages(ctx: StepStartContext): Promise<void> {
    const messages = this.pending.splice(0);
    if (messages.length === 0) return;
    ctx.context.add({ role: 'system', content: messages.join('\n\n') });
  }

  async onDestroy(): Promise<void> {
    this.controller?.abort();
  }
}
```

关键点：

- 事件回调只写 Feature buffer，不并发修改 Context；
- 在 StepStart 等钩子边界批量注入；
- 定义空闲时如何处理消息；
- 销毁时停止轮询；
- 若 buffer 需要跟随回滚，进入快照；否则明确它是实时外部状态。

## 值快照与资源重建模式

```ts
class SearchFeature implements AgentFeature {
  private recentQueries: string[] = [];
  private client?: SearchClient;

  async onInitiate(ctx: FeatureInitContext) {
    this.client = await SearchClient.connect(parseConfig(ctx.featureConfig));
  }

  captureState() {
    return { recentQueries: [...this.recentQueries] };
  }

  restoreState(snapshot: unknown) {
    const state = snapshot as { recentQueries?: unknown[] } | null;
    this.recentQueries = Array.isArray(state?.recentQueries)
      ? state.recentQueries.filter((q): q is string => typeof q === 'string')
      : [];
  }
}
```

`client` 由初始化建立，`recentQueries` 由快照恢复。不要序列化 client，也不要在 restore 中假装恢复旧连接。

## Feature 自带 Skill 模式

当工具之间有非显然的使用顺序、限制或恢复策略时，把知识放进 `skills/`：

```text
skills/
└── manage-records/
    └── SKILL.md
```

Skill 负责教 Agent：

- 先查后改；
- 批量操作的上限；
- 哪些工具可并发；
- 写操作前的确认条件；
- 错误结果怎样重试。

工具描述负责单个工具，Skill 负责跨工具工作流。

## 应避免的结构

### 万能 Feature

一个 Feature 拥有多个无关领域、几十个共享不明的工具和大块状态。拆成主题明确的能力单元。

### 工具执行函数承载全部架构

`execute()` 同时连接客户端、解析配置、维护状态机、注入上下文和管理进程。把资源放进生命周期，把业务放进服务，把运行控制放进 hooks。

### 隐式共享内部状态

其他 Feature 直接读取私有字段或修改集合。改为小型公开 API 和值返回。

### 假快照

把客户端、worker 或活动任务塞进 snapshot。只保存行为所需的纯数据。

### 无退出条件的续跑

StepFinish guard 总是返回 `Approve` 会让 call 持续循环。为续跑条件提供明确状态、最大次数和终止路径。

### 并发写共享状态

多个 `parallelizable` 工具修改同一个数组、文件或远端对象。去掉并发标记，或把操作设计成真正独立。

### manifest 与实现分离

UI 显示了默认值，但 `onInitiate()` 没有解析 `ctx.featureConfig`。让声明、默认值和运行时解析保持同一语义。
