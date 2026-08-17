# Feature 模型与完整接口

## 目录

- [Feature 的职责](#feature-的职责)
- [AgentFeature 接口](#agentfeature-接口)
- [初始化上下文](#初始化上下文)
- [装配顺序](#装配顺序)
- [配置契约](#配置契约)
- [状态与恢复](#状态与恢复)
- [Feature 自带 Skills](#feature-自带-skills)
- [目录与测试](#目录与测试)

## Feature 的职责

Feature 是一个可组合能力包。它可以同时拥有：

- Agent 可调用的工具；
- 对 call、step、tool 生命周期的处理；
- 项目级配置；
- 少量影响行为的逻辑状态；
- 客户端、轮询器等运行时资源；
- 查看器模板；
- 教 Agent 使用该能力的 skills。

保持主题内聚。例如，“代码搜索”可以包含搜索工具、索引客户端、搜索结果模板和使用说明；不要把邮件、日历和文件系统工具放进同一个 Feature。

## AgentFeature 接口

```ts
interface AgentFeature {
  readonly name: string;
  readonly source?: string;
  readonly description?: string;

  getTools?(): Tool[];
  getAsyncTools?(ctx: FeatureInitContext): Promise<Tool[]>;

  getPackageInfo?(): PackageInfo | null;
  getTemplateNames?(): string[];
  getRenderTemplates?(): Record<string, InlineRenderTemplate>;

  getFeatureManifest?(): FeatureManifestDefinition | null;
  getContextInjectors?(): Map<string | RegExp, ContextInjector>;

  onInitiate?(ctx: FeatureInitContext): Promise<void>;
  onDestroy?(ctx: FeatureContext): Promise<void>;

  captureState?(): FeatureStateSnapshot;
  restoreState?(snapshot: FeatureStateSnapshot): void | Promise<void>;
  beforeRollback?(snapshot: FeatureStateSnapshot): void | Promise<void>;
  afterRollback?(snapshot: FeatureStateSnapshot): void | Promise<void>;

  getHookDescription?(lifecycle: string, methodName: string): string | undefined;
}
```

接口之外还有两个静态声明（挂在类上，不在接口实例成员里）：

- `static hooks`：反向钩子声明，见 [反向 Hook 参考](../runtime/reverse-hooks-reference.md)；
- `static inject`：依赖的 Feature `name` 列表，装配时拓扑排序，缺失依赖 / 循环依赖 / 重名是启动错误。

字段用途：

- `name`：Feature 的唯一标识，也是 `AgentConfig.features[name]` 的配置键。
- `description`：说明能力范围，供调试器和维护者识别。
- `source`：源码或构建入口的绝对路径，支持包信息和 Feature skills 发现。

只实现需要的方法。不要返回空壳方法来模拟“完整”。

## 初始化上下文

```ts
interface FeatureInitContext {
  agentId: string;
  config: AgentConfig;
  logger: Logger;
  featureConfig?: unknown;
  getFeature<T extends AgentFeature>(name: string): T | undefined;
  registerTool(tool: Tool): void;
}
```

常见用法：

```ts
async onInitiate(ctx: FeatureInitContext): Promise<void> {
  this.logger = ctx.logger;
  this.workspaceDir = ctx.config.workspaceDir ?? process.cwd();
  this.settings = parseSettings(ctx.featureConfig);

  const index = ctx.getFeature<SearchIndexApi & AgentFeature>('search-index');
  if (!index) throw new Error('search-index feature is required');
  this.index = index;
}
```

`FeatureInitContext` 是初始化入口，不是完整 Agent 句柄。工具运行时需要的数据应通过闭包、公开 API 或 `getContextInjectors()` 提供。

## 装配顺序

使用 `agent.use(feature)` 将 Feature 加入 Agent。Agent 准备 Feature 时：

1. 解析依赖拓扑（`static inject`），依赖先于依赖方初始化；同时校验 policy guard 唯一性，错误在装配时抛出；
2. 收集所有 Feature 自带的 skills；
3. 按拓扑顺序对每个 Feature 执行：`getTools()` 注册同步工具 → `getAsyncTools(ctx)` 注册异步工具 → `onInitiate(ctx)` → 收集 `static hooks` 声明的反向钩子；
4. 所有 Feature 完成后，调用 Agent 子类的 `onFeatureToolsReady()`。

`getContextInjectors()` 在 `use(feature)` 时收集，因此注入器应在构造后即可返回。

运行时新增 Feature 使用：

```ts
await agent.mountFeature(new SearchFeature());
```

Agent 已完成 Feature 准备时，`mountFeature()` 会立即注册工具、初始化资源并收集 hooks；首次 call 尚未发生时，它只加入待准备集合。需要替换已挂载的同名 Feature 时，先清理旧 Feature，再挂载新实例；避免让旧工具、hooks 或注入器继续存在。

自定义 Agent 若要在全部 Feature 工具之后注册统一入口，可覆盖：

```ts
protected override async onFeatureToolsReady(): Promise<void> {
  this.getTools().register(createUnifiedTool(), 'agent');
}
```

## 配置契约

`getFeatureManifest()` 声明配置表面；`ctx.featureConfig` 提供实际配置值。

```ts
getFeatureManifest(): FeatureManifestDefinition {
  return {
    schemaVersion: 1,
    settings: {
      properties: {
        enabled: {
          type: 'boolean',
          title: '启用能力',
          default: true,
        },
        strategy: {
          type: 'select',
          title: '处理策略',
          options: [
            { label: '快速', value: 'fast' },
            { label: '完整', value: 'thorough' },
          ],
          default: 'fast',
        },
        timeoutMs: {
          type: 'number',
          title: '超时毫秒数',
          min: 100,
          max: 60_000,
          step: 100,
          default: 5_000,
        },
      },
      sections: [
        { id: 'general', title: '通用', properties: ['enabled', 'strategy', 'timeoutMs'] },
      ],
    },
  };
}
```

支持的属性类型：`string`、`number`、`boolean`、`select`、`file`、`directory`、`group`。可用 `showWhen` 控制同级字段的条件显示。

manifest 的默认值是声明；Feature 仍需解析输入：

```ts
function parseSettings(raw: unknown) {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    enabled: value.enabled !== false,
    timeoutMs: typeof value.timeoutMs === 'number' ? value.timeoutMs : 5_000,
  };
}
```

## 状态与恢复

只有同时实现 `captureState()` 和 `restoreState()` 的 Feature 才会进入 Agent 的 Feature 快照。

适合快照的数据：

- 数组、普通对象、字符串、数字和布尔值；
- 任务、计数器、模式、已读集合、有限状态机状态；
- 能明确表达行为的最小数据集合。

不放入快照的数据：

- socket、客户端、子进程、定时器和 worker；
- Promise、函数和不可序列化句柄；
- 可以随时重新计算的缓存。

```ts
captureState() {
  return {
    enabled: this.enabled,
    seenIds: [...this.seenIds],
  };
}

restoreState(snapshot: unknown): void {
  const state = snapshot as { enabled?: boolean; seenIds?: unknown[] } | null;
  this.enabled = state?.enabled !== false;
  this.seenIds = new Set(
    Array.isArray(state?.seenIds)
      ? state.seenIds.filter((id): id is string => typeof id === 'string')
      : [],
  );
}
```

Agent 会按值保存快照。`restoreState()` 要验证输入并完整覆盖逻辑状态。

`beforeRollback()` / `afterRollback()` 用于 step rollback 前后的额外处理。所有恢复路径都依赖 `restoreState()`，因此不要把必要恢复逻辑只放在 rollback hooks 中。

## Feature 自带 Skills

Feature 可以携带教 Agent 使用该能力的 skills：

```text
my-feature/
├── src/
│   └── index.ts
├── skills/
│   └── use-my-feature/
│       └── SKILL.md
└── dist/
    ├── index.js
    └── skills/
        └── use-my-feature/
            └── SKILL.md
```

设置 `feature.source`，并让构建流程把 `skills/` 复制到包的 `dist/skills/`。Agent 会在 Feature 初始化前收集这些 skills，并交给名为 `skill` 的 Feature。工作区中的同名 skill 优先。

Feature skill 应说明：

- Agent 什么时候使用这项能力；
- 多个工具如何协作；
- 哪些前置条件和限制需要遵守；
- 常见失败后怎样恢复。

## 目录与测试

框架内 Feature 的推荐结构：

```text
src/features/my-feature/
├── index.ts
├── tools.ts
├── types.ts
├── templates/
│   └── my-tool.render.ts
├── skills/
│   └── use-my-feature/SKILL.md
└── test/
    └── smoke.test.ts
```

AgentDev 源码仓库使用 Vitest，并发现 `src/features/*/test/**/*.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { NotesFeature } from '../index.js';

describe('NotesFeature', () => {
  it('restores notes from a value snapshot', () => {
    const feature = new NotesFeature();
    feature.restoreState({ notes: ['a'] });
    expect(feature.captureState()).toEqual({ notes: ['a'] });
  });
});
```

独立 Feature 包沿用包自身的测试配置；至少覆盖工具 schema、关键执行路径、决策 hooks、配置解析和快照往返。
