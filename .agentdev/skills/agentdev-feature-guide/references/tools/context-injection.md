# 工具上下文注入

## 目录

- [注入模型](#注入模型)
- [匹配规则](#匹配规则)
- [合并规则](#合并规则)
- [注入内容](#注入内容)
- [失败与清理](#失败与清理)
- [测试](#测试)

## 注入模型

`getContextInjectors()` 返回工具名或正则到同步函数的映射：

```ts
getContextInjectors(): Map<string | RegExp, ContextInjector> {
  return this.injectors;
}
```

工具执行时，框架依次合并所有匹配结果，再加入：

- `signal`；
- `registerContinuationRequest`。

注入器接收 `ToolCall`，可读取 `id`、`name` 和 `arguments`。它不接收 Agent，也不应执行异步 I/O。

## 匹配规则

字符串进行精确匹配：

```ts
new Map([
  ['record_update', () => ({ recordRuntime: this.runtime })],
]);
```

正则适合工具族：

```ts
new Map([
  [/^record_/, call => ({ requestMeta: { toolCallId: call.id } })],
]);
```

不要使用 `g` 或 `y` 标志。框架重复调用同一个正则的 `test()`，有状态 `lastIndex` 会造成交替匹配。

## 合并规则

注入结果是浅合并，后匹配项覆盖同名顶层字段：

```ts
{ ...first, ...second, signal, registerContinuationRequest }
```

因此：

- 为每个 Feature 使用唯一命名空间字段；
- 不注入通用名称 `client`、`config`、`state`；
- 不覆盖 `signal` 或 `registerContinuationRequest`；
- 多个注入器要共享嵌套字段时，在同一个注入器内组装；
- 测试注册顺序变化不会改变关键语义。

```ts
return {
  recordFeature: {
    client: this.client,
    workspaceId: this.workspaceId,
    readiness: this.readiness,
  },
};
```

## 注入内容

适合注入：

- 已初始化客户端引用；
- Feature 的小型公开 API；
- 当前配置的只读视图；
- 工具调用关联 ID；
- 测试可替换的时钟或适配器。

避免注入：

- 完整 Agent；
- Context；
- 无边界的内部可变集合；
- 每次调用新建的网络连接；
- 密钥副本和不需要的环境变量；
- 与工具无关的大对象。

工具必须验证上下文存在：

```ts
const runtime = context?.recordFeature as RecordRuntime | undefined;
if (!runtime?.client) {
  throw new Error('record feature is not ready; check initialization logs');
}
```

## 失败与清理

注入器抛错会被工具执行器捕获，并表现为工具失败。注入器本身保持纯同步和无异常；就绪检查放在返回对象或工具入口。

Agent 在 `use(feature)` 时收集注入器。为动态移除准备稳定对象：

```ts
private readonly recordPattern = /^record_/;
private readonly injectors = new Map<string | RegExp, ContextInjector>([
  [this.recordPattern, () => ({ recordFeature: this.runtimeView() })],
]);
```

不要每次 `getContextInjectors()` 都创建新 `RegExp` 和新函数。动态移除按模式对象身份查找，稳定引用更容易正确清理。

## 测试

- 精确名称匹配与不匹配；
- 正则匹配多个工具；
- 连续调用不会出现 `lastIndex` 问题；
- 多注入器浅合并后的字段；
- Feature 未就绪时的错误；
- `signal` 和 continuation 函数仍存在；
- 动态移除后注入器不再生效。
