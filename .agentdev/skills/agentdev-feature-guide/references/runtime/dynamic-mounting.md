# 动态挂载、替换与工具状态

## 目录

- [静态与动态装配](#静态与动态装配)
- [挂载语义](#挂载语义)
- [移除语义](#移除语义)
- [安全替换流程](#安全替换流程)
- [配置重载](#配置重载)
- [验证](#验证)

## 静态与动态装配

首次 call 前使用：

```ts
agent.use(new SearchFeature());
```

运行期使用：

```ts
await agent.mountFeature(new SearchFeature());
```

`use()` 只登记实例并立即收集 context injectors。Feature 准备尚未完成时，工具、资源和 hooks 在统一准备阶段初始化。

## 挂载语义

Agent 已完成准备时，`mountFeature()` 执行：

1. `use(feature)`；
2. 注册同步工具；
3. 发现异步工具；
4. 调用 `onInitiate()`；
5. 收集 hooks；
6. 推送 inspector 快照。

挂载同名 Feature 会直接替换 Feature map 中的实例，但旧实例的工具覆盖历史、injectors、hooks 和资源可能仍存在。不要把同名 `mountFeature()` 当作原子替换。

## 移除语义

```ts
agent.removeFeature('search');
```

移除会：

- 依据 `getTools()` 移除同步工具；
- 移除该实例的 hooks；
- 尝试移除 context injectors；
- 从 Feature map 删除实例；
- 触发 `onDestroy()`；
- 更新 inspector。

边界：

- 异步工具和 `ctx.registerTool()` 工具不会由 `getTools()` 枚举；
- `removeFeature()` 不等待异步 `onDestroy()`；
- injector 清理依赖稳定的 pattern 对象；
- 外部事件源必须由 Feature 主动停止。

## 安全替换流程

```ts
const oldFeature = agent.getFeature<SearchFeature>('search');
if (oldFeature) await oldFeature.stop();
agent.removeFeature('search');
await agent.mountFeature(new SearchFeature(nextConfig));
```

高要求场景采用先建后切：

1. 在独立对象上验证新配置；
2. 建立新客户端并完成健康检查；
3. 停止旧 Feature 接收新工作；
4. 等待旧活动任务结束；
5. 移除旧实例；
6. 挂载已准备的新实例；
7. 验证工具、hooks 和 inspector；
8. 新实例失败时恢复旧实例或进入明确 degraded 状态。

## 配置重载

简单 Feature 可替换整个实例。需要不停机重载时实现原子 `reload(config)`：

- 先解析并验证新配置；
- 在局部变量创建新资源；
- 健康检查通过后交换引用；
- 活动工具调用继续使用捕获的旧引用；
- 等旧调用结束再释放旧资源；
- 失败时保持原配置和资源不变。

不要逐字段修改配置后再逐步重连，这会产生混合状态。

## 验证

- 首次 call 前 mount 与 use 行为一致；
- 运行期 mount 立即出现工具和 hooks；
- 同步、异步和动态工具均有清理策略；
- stable injector 在移除后不再匹配；
- stop 被等待后资源确实关闭；
- 同名替换不保留旧 hook；
- 配置重载失败不影响旧实例；
- inspector 中没有意外 superseded 或 partial 状态。
