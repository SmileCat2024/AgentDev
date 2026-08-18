# 反向钩子与运行时控制

Feature 参与运行循环的唯一方式是**静态钩子声明**（`static hooks`）。没有声明的方法不会被调用——没有方法名约定，也没有第二条注册路径。

## 目录

- [唯一契约：static hooks](#唯一契约static-hooks)
- [三原语：observe / guard / transform](#三原语observe--guard--transform)
- [guard 角色：policy 与 advisor](#guard-角色policy-与-advisor)
- [导入清单](#导入清单)
- [AgentInitiate](#agentinitiate)
- [AgentDestroy](#agentdestroy)
- [CallStart](#callstart)
- [CallFinish](#callfinish)
- [StepStart](#stepstart)
- [StepFinish](#stepfinish)
- [ToolUse](#tooluse)
- [ToolFinished](#toolfinished)
- [ToolResultTransform](#toolresulttransform)
- [执行顺序与短路](#执行顺序与短路)
- [装配校验错误对照](#装配校验错误对照)
- [依赖声明：static inject](#依赖声明static-inject)
- [继承与组合](#继承与组合)
- [调试说明](#调试说明)

## 唯一契约：static hooks

在 Feature 类上声明静态属性 `hooks`，键是**本类中的方法名**，值是生命周期 + 三原语声明：

```ts
import { CoreLifecycle, Decision } from 'agentdev';
import type { HookDeclarations } from 'agentdev';
import type {
  CallStartContext,
  CallFinishContext,
  ToolContext,
  ToolResultTransformContext,
} from 'agentdev';

export class MyFeature implements AgentFeature {
  static hooks: HookDeclarations = {
    onCallStart:   { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
    onCallFinish:  { lifecycle: CoreLifecycle.CallFinish, kind: 'observe' as const },
    guardTool:     { lifecycle: CoreLifecycle.ToolUse, kind: 'guard' as const, role: 'advisor' as const },
    transformTool: { lifecycle: CoreLifecycle.ToolResultTransform, kind: 'transform' as const },
  };

  readonly name = 'my-feature';

  async onCallStart(ctx: CallStartContext): Promise<void> { /* ... */ }
  async onCallFinish(ctx: CallFinishContext): Promise<void> { /* ... */ }
  async guardTool(ctx: ToolContext) { return Decision.Continue; }
  async transformTool(ctx: ToolResultTransformContext) { return undefined; }
}
```

三条基本规则：

1. **没有声明 = 没有钩子**。方法写了、忘写 `static hooks`，方法永远不会被调用。
2. **声明指向的方法必须存在且是函数**。装配校验失败会直接抛错，不会静默跳过。
3. **kind 由作者声明，不由生命周期推断**。写错 kind 与 lifecycle 的组合（如 guard 挂在 CallStart 上）会在装配时报错。

`kind: 'observe' as const` 中的 `as const` 是 TypeScript 要求（字面量类型收窄），纯 JavaScript 里直接写 `kind: 'observe'` 即可——**JS 与 TS 写法完全等价**。

## JS 与 TS 双态速查

TS 示例中的 `Decision` / `CoreLifecycle` 是字符串枚举，**枚举成员的运行时值就是小写字符串 / 成员名本身**：

| TS 写法 | JS 等价字面量 |
|---|---|
| `Decision.Approve` | `'approve'` |
| `Decision.Deny` | `'deny'` |
| `Decision.Continue` | `'continue'` |
| `CoreLifecycle.ToolUse` | `'ToolUse'` |
| `CoreLifecycle.CallStart` | `'CallStart'` |

`normalizeDecision` 直接接受字符串（`'deny'`）或对象（`{ action: 'deny', reason: '...' }`）两种形态，两者运行时完全等价。

**纯 JavaScript 模块（如 Agent Studio 项目目录下的 `.mjs` Feature）不需要也不应该 `import 'agentdev'`**：新项目目录通常没有可解析的 `node_modules`，import 失败会导致模块加载即 mount 失败。直接写字面量：

```js
export class MyGuardFeature {
  static hooks = {
    guardSpend: { lifecycle: 'ToolUse', kind: 'guard', role: 'policy' },
  };
  async guardSpend(ctx) {
    if (overBudget(ctx)) return { action: 'deny', reason: '预算不足' };
    return 'continue';
  }
}
```

TS 枚举名（`Decision.Deny`）只是类型层的方便；运行时决策比较用的是小写字符串，写 `'Deny'`（大写）不等于 `'deny'`，不会命中任何决策分支。

## 三原语：observe / guard / transform

| kind | 语义 | 返回值 | 合法生命周期 |
|---|---|---|---|
| `observe` | 观察、记录、注入——不参与流程控制 | **框架直接丢弃**（写 void） | 任意 |
| `guard` | 流程裁决（批准 / 拒绝 / 放行） | `DecisionResult` | 仅 `ToolUse`、`StepFinish` |
| `transform` | 数据变换（链式） | 新结果或 `undefined`（不修改） | 仅 `ToolResultTransform` |

关键行为差异：

- observe / transform 的返回值会被框架**无条件丢弃**——不要试图用 observe 钩子控制流程，它不会产生任何效果。
- guard 返回 `Approve` / `Deny` 会立即停止同生命周期后续 guard；返回 `Continue`（或 `undefined`）继续。
- transform 钩子按注册顺序链式执行，前一个的输出是后一个的输入；抛异常的 transform 被跳过，当前值继续传递。

## guard 角色：policy 与 advisor

guard 钩子可声明 `role`：

- `policy`（策略方）：**先执行**。一次装配中每个生命周期的 policy **至多一个**，出现两个会在装配时抛 `duplicate_policy` 错误。
- `advisor`（顾问方）：policy 之后执行。未声明 role 时默认 advisor。

用法约定：

- 真正持有裁决权的 feature（如安全准入、配额控制）声明 `role: 'policy'`；
- 提供"建议但不抢占"的判断（如审计性校验、非关键拦截）保持 advisor；
- 不要为了执行顺序靠前而滥用 policy——两个 policy 直接装配失败。

## 导入清单

从 `agentdev` 包根导入（框架内副本从对应相对路径导入）：

```ts
import { CoreLifecycle, Decision, normalizeDecision } from 'agentdev';
import type {
  HookDeclarations,
  CallStartContext,
  CallFinishContext,
  StepStartContext,
  StepFinishDecisionContext,
  ToolContext,
  ToolFinishedDecisionContext,
  ToolResultTransformContext,
} from 'agentdev';
```

上下文类型、`CoreLifecycle`、`Decision`、`HookDeclarations` 都从包根导出。如果某个导入名报"不存在"，先对照上表和 `CoreLifecycle` 枚举成员核对拼写。

## AgentInitiate

Agent 首次进入工作状态时触发一次。适合长生命周期资源准备：启动后台服务、建立连接、预热缓存。

```ts
static hooks: HookDeclarations = {
  boot: { lifecycle: CoreLifecycle.AgentInitiate, kind: 'observe' as const },
};

async boot(ctx: AgentInitiateContext): Promise<void> {
  await this.indexWorkspace();
}
```

与 Feature 方法 `onInitiate(ctx)` 的区别：`onInitiate` 由 Feature 接口直接调用并传入完整 `FeatureInitContext`（含 `registerTool`、`featureConfig`）；`AgentInitiate` 钩子只收到 `{ context }`。**资源初始化优先用 `onInitiate()`**，`AgentInitiate` 钩子适合观察整个 agent 启动事件。

## AgentDestroy

Agent 生命周期收尾。释放外部资源、停止后台线程、断开连接、缓存落盘。

```ts
static hooks: HookDeclarations = {
  cleanup: { lifecycle: CoreLifecycle.AgentDestroy, kind: 'observe' as const },
};

async cleanup(ctx: AgentDestroyContext): Promise<void> {
  await this.workerPool.stop();
}
```

与 `onDestroy(ctx)` 的分工同上：**资源清理优先用 `onDestroy()`**。

## CallStart

发生在系统提示词之后、用户输入正式写入 Context 之前。适合输入重写、前置注入、模式切换、slash command。

```ts
static hooks: HookDeclarations = {
  normalizeCommand: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
};

async normalizeCommand(ctx: CallStartContext): Promise<void> {
  const input = ctx.agent?.getUserInput() ?? ctx.input;
  if (input.startsWith('/plain ')) {
    ctx.agent?.setUserInput(input.slice('/plain '.length));
  }
}
```

链式改写时始终读 `ctx.agent.getUserInput()`，这样能看到前一个 CallStart 钩子已写入的值；`ctx.input` 是原始输入。

## CallFinish

一次完整 call 结束后的结算点。适合摘要、记录、指标更新、通知——不适合决定下一轮 ReAct 是否继续（那是 StepFinish 的事）。

```ts
static hooks: HookDeclarations = {
  recordCompletion: { lifecycle: CoreLifecycle.CallFinish, kind: 'observe' as const },
};

async recordCompletion(ctx: CallFinishContext): Promise<void> {
  this.metrics.track(ctx.completed, ctx.steps, ctx.finishReason);
}
```

用 `ctx.finishReason` 判断结束原因（`completed | interrupted | api_error | error | max_steps | continuation | exception`），不要解析 `response` 文本。`continuation` 表示 call 暂停续接而非真正结束，通知类钩子通常要跳过它。

## StepStart

每轮 ReAct 迭代开始、LLM 调用前。适合上下文补丁、条件提醒注入。高频触发，保持轻量。

```ts
static hooks: HookDeclarations = {
  injectReminder: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' as const },
};

async injectReminder(ctx: StepStartContext): Promise<void> {
  if (!this.shouldRemind()) return;
  ctx.context.add({ role: 'system', content: this.buildReminder() });
}
```

提醒只在条件满足时注入、保持简短、避免每 step 重复同一大段内容；为"已注入边界"状态实现快照恢复。

## StepFinish

ReAct 循环最关键的控制点。模型和工具跑完后，决定"继续下一轮"还是"就地结束"。guard 专属。

```ts
static hooks: HookDeclarations = {
  decideNextStep: {
    lifecycle: CoreLifecycle.StepFinish,
    kind: 'guard' as const,
    role: 'advisor' as const,
  },
};

async decideNextStep(ctx: StepFinishDecisionContext) {
  if (this.mustStop()) {
    return { action: Decision.Deny, reason: '目标已完成' };
  }
  if (ctx.toolCallsCount === 0 && this.pending.length > 0) {
    ctx.context.add({ role: 'system', content: '仍有待处理事项，请继续完成。' });
    return Decision.Approve;
  }
  return Decision.Continue;
}
```

Decision 语义（StepFinish 语境）：

- `Approve`：要求继续下一 step；
- `Deny`：结束当前 call；
- `Continue`：交给后续 hook 或默认 ReAct 结束规则。

不要无条件返回 `Approve`，否则 call 持续循环。为续跑条件设计明确的退出状态、最大次数和测试。

## ToolUse

工具真正执行前的裁决点。安全策略、危险操作拦截、参数标准化的归属地。guard 专属。

```ts
static hooks: HookDeclarations = {
  validateWrite: {
    lifecycle: CoreLifecycle.ToolUse,
    kind: 'guard' as const,
    role: 'advisor' as const,
  },
};

async validateWrite(ctx: ToolContext) {
  if (ctx.call.name !== 'record_update') return Decision.Continue;

  const id = String(ctx.call.arguments?.id ?? '').trim();
  if (!id) {
    return { action: Decision.Deny, reason: 'record_update.id 不能为空' };
  }
  ctx.call.arguments.id = id;
  return Decision.Continue;
}
```

Decision 语义（ToolUse 语境）：

- `Approve`：明确允许并跳过后续 guard；
- `Deny`：阻止执行，原因作为错误结果；
- `Continue`：交给后续 guard 或默认放行。

工具自己的 `execute()` 仍要验证安全关键参数——hook 负责统一策略，工具负责自身不变量。

## ToolFinished

工具返回结果后的纯通知。适合审计、索引、同步外部状态、记录指标。observe 专属。

```ts
static hooks: HookDeclarations = {
  auditResult: { lifecycle: CoreLifecycle.ToolFinished, kind: 'observe' as const },
};

async auditResult(ctx: ToolFinishedDecisionContext): Promise<void> {
  if (!ctx.toolName.startsWith('record_')) return;
  this.auditTrail.push({ tool: ctx.toolName, duration: ctx.duration });
}
```

工具成功、失败、被禁用或被拦截都会收到通知。返回值被丢弃，不控制流程。

## ToolResultTransform

工具结果写入 Context 之前的变换点。输出截断、脱敏、格式清理的归属地。transform 专属。

```ts
static hooks: HookDeclarations = {
  truncateOutput: { lifecycle: CoreLifecycle.ToolResultTransform, kind: 'transform' as const },
};

async truncateOutput(ctx: ToolResultTransformContext) {
  if (ctx.toolName !== 'read_file') return undefined; // 不修改
  const text = String(ctx.result.data ?? '');
  if (text.length <= 10_000) return undefined;
  return {
    ...ctx.result,
    data: text.slice(0, 10_000) + `\n...[截断，完整内容 ${text.length} 字符]`,
  };
}
```

链式语义：多个 transform 按注册顺序执行，前一个的输出是后一个的输入；返回 `undefined` 表示不修改；抛异常的钩子被跳过（当前值继续传递，不中断链）。

## 执行顺序与短路

同一生命周期内，钩子按三原语稳定分区排序：

1. guard + `policy`（组内保持注册序）
2. guard + `advisor`（组内保持注册序）
3. observe / transform（保持注册序）

短路规则只作用于 guard：第一个返回 `Approve` 或 `Deny` 的 guard 立即终止后续所有 guard；observe 钩子始终全部执行（返回值丢弃，无法短路）。

因此：

- 需要最优先裁决的安全策略声明 `role: 'policy'`；
- 不需要抢占时返回 `Continue`；
- 安全钩子在异常时显式 fail-closed（返回 `Deny`），不要依赖抛异常——异常会被记录并跳过，效果是 fail-open。

## 装配校验错误对照

声明错误在装配时（首次 `onCall` 的 `ensureFeatureTools` 或 `mountFeature`）抛出，**不会运行时静默失效**。对照表：

| 错误码 | 含义与修复 |
|---|---|
| `method_missing` | 声明的方法在类中不存在。实现该方法，或删声明。 |
| `method_not_function` | 声明指向的成员不是函数（可能被字段覆盖）。 |
| `invalid_kind` | kind 不是 `observe / guard / transform`。 |
| `invalid_lifecycle` | lifecycle 不是 `CoreLifecycle` 枚举值。 |
| `invalid_kind_lifecycle` | 组合非法（guard 只能 ToolUse/StepFinish；transform 只能 ToolResultTransform）。 |
| `role_on_non_guard` | observe/transform 上声明了 role。删掉 role 字段。 |
| `duplicate_policy` | 同一 lifecycle 出现第二个 policy。保留一个，其余改 advisor。 |

依赖侧（`static inject`）的错误：`missing_dependency`（装配中不存在声明的依赖）、`circular_dependency`（依赖成环，报错带完整环路径）、`duplicate_feature_name`（两个 Feature 同名）。

## 依赖声明：static inject

Feature 依赖通过**静态属性**声明（实例字段已移除）：

```ts
export class SearchFeature implements AgentFeature {
  readonly name = 'search';
  static inject = ['search-index']; // 依赖的 feature name

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    const index = ctx.getFeature<AgentFeature & SearchIndexApi>('search-index');
    if (!index) throw new Error('search-index feature is required');
    this.index = index;
  }
}
```

装配时框架做拓扑排序：依赖先于依赖方初始化；缺失依赖、循环依赖、重名都是启动错误。

注意：`static inject` 保证初始化顺序，不注入实例。运行时仍用 `ctx.getFeature(name)` 解析，并优先读取对方的公开 API 而非内部字段。

## 继承与组合

`static hooks` 挂在类上，子类通过原型链继承父类的声明。扩展父类钩子时**覆盖同名方法**，不需要也不应该重新声明：

```ts
class BaseFeature implements AgentFeature {
  static hooks: HookDeclarations = {
    decideNextStep: { lifecycle: CoreLifecycle.StepFinish, kind: 'guard' as const, role: 'advisor' as const },
  };
  async decideNextStep(ctx: StepFinishDecisionContext) { return Decision.Continue; }
}

class ExtendedFeature extends BaseFeature {
  // 覆盖方法即可；static hooks 从父类继承
  override async decideNextStep(ctx: StepFinishDecisionContext) {
    const base = await super.decideNextStep(ctx);
    if (this.extraStopCondition()) return Decision.Deny;
    return base;
  }
}
```

子类新增钩子时，可以重新声明完整的 `static hooks`（覆盖父类声明——静态属性不合并，是整体替换）：

```ts
class ExtendedFeature extends BaseFeature {
  static hooks: HookDeclarations = {
    ...BaseFeature.hooks, // 显式展开父类声明
    extraObserve: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' as const },
  };
}
```

忘记展开父类声明时，父类钩子会静默消失——继承扩展时务必检查 `static hooks` 的完整性。

## 调试说明

为钩子提供人类可读说明（会出现在 inspector snapshot 中）：

```ts
getHookDescription(lifecycle: string, methodName: string): string | undefined {
  if (lifecycle === 'ToolUse' && methodName === 'validateWrite') {
    return '校验记录写入范围并标准化 ID。';
  }
  return undefined;
}
```

排查钩子问题的顺序：

1. `static hooks` 是否声明了该方法（无声明 = 无钩子）；
2. 声明的方法名与实际方法名拼写一致；
3. kind / lifecycle / role 组合合法（对照上方错误表）；
4. inspector（`/api/agents/:id/hooks`）中该生命周期是否有此条目、`enabled` 是否为 true；
5. 日志过滤 `agent.reverse-hook` 命名空间，查看 `hook.invoked` 事件与执行耗时。

Hook 执行日志自动携带 feature 名、lifecycle、方法名、kind。日志应记录决策依据，不要把完整敏感参数或大对象写入日志。
