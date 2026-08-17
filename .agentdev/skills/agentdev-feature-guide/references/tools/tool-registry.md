# 工具注册、覆盖与可见状态

## 目录

- [注册来源](#注册来源)
- [同名覆盖](#同名覆盖)
- [启用、禁用与移除](#启用禁用与移除)
- [Feature 级控制](#feature-级控制)
- [动态工具追踪](#动态工具追踪)
- [检查清单](#检查清单)

## 注册来源

工具可以来自：

- `getTools()` 返回；
- `getAsyncTools(ctx)` 返回；
- `ctx.registerTool(tool)`；
- Agent 构造配置中的 standalone tools；
- Agent 子类在 `onFeatureToolsReady()` 注册。

同一个工具只选择一种注册路径。`getAsyncTools()` 中调用 `ctx.registerTool()` 后再返回同名工具会形成一次覆盖。

`getTools()` 保持确定、无副作用、可重复调用。Feature 级 `enable()`、`disable()`、`remove()` 和 `removeFeature()` 会再次调用它来取得工具名。

## 同名覆盖

ToolRegistry 以 `tool.name` 为键。后注册工具成为当前生效项，旧条目保留为 `superseded` 供 inspector 查看。

覆盖策略必须显式：

- 不同语义使用不同名称；
- 有意覆盖时记录来源和原因；
- 统一代理工具放在 `onFeatureToolsReady()`；
- 测试最终 `getSource(name)` 和描述；
- 不依赖偶然 import 顺序。

一个 Feature 被同名新实例覆盖时，旧实例的 context injector 和资源不会自动消失。运行中的替换使用明确清理流程。

## 启用、禁用与移除

三个状态语义不同：

| 状态 | LLM 是否可见 | 能否执行 |
|---|---:|---:|
| enabled | 是 | 是 |
| disabled | 是 | 否，返回禁用错误 |
| removed | 否 | 否 |

禁用适合告诉 Agent“能力存在但当前不可用”。移除适合不希望模型选择该工具的场景。

ToolRegistry 支持在工具注册前预禁用或预移除：

```ts
agent.getTools().disable('future_tool');
agent.use(new RemoteFeature());
```

后续同名工具注册时会继承该状态。`enable(name)` 同时取消预禁用和预移除。

## Feature 级控制

```ts
agent.enable('search');
agent.disable('search');
agent.remove('search');
```

这些方法通过 `feature.getTools()` 枚举名称，因此天然只覆盖同步声明的工具。异步发现工具和 `ctx.registerTool()` 动态工具需要 Feature 自己记录名称，再由公开 API 或装配层逐个控制。

`remove('feature-name')` 只改变工具可见状态，不销毁 Feature。`removeFeature('feature-name')` 还移除实例和 hooks，并触发资源清理。

## 动态工具追踪

为动态工具保存稳定集合：

```ts
private readonly registeredToolNames = new Set<string>();

private register(ctx: FeatureInitContext, tool: Tool): void {
  ctx.registerTool(tool);
  this.registeredToolNames.add(tool.name);
}

listRegisteredToolNames(): readonly string[] {
  return [...this.registeredToolNames];
}
```

名称集合用于：

- 禁用、移除和替换；
- 检查远端重新发现的差异；
- 日志和 inspector 对账；
- 检测名称碰撞；
- 测试清理是否完整。

## 检查清单

- 每个工具是否只有一条注册路径？
- `getTools()` 是否每次返回同一名称集合？
- 同名覆盖是否有意且经过测试？
- 是否区分 disabled 与 removed？
- Feature 级控制是否遗漏异步工具？
- 动态工具名称是否被追踪？
- 替换 Feature 前是否清理旧实例、hooks、injectors 和资源？
