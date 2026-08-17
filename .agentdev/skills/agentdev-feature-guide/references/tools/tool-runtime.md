# 工具运行模型

## 目录

- [Tool 接口](#tool-接口)
- [工具准备](#工具准备)
- [单工具执行顺序](#单工具执行顺序)
- [执行上下文](#执行上下文)
- [结果转换](#结果转换)
- [独占与并发](#独占与并发)
- [Continuation](#continuation)
- [运行时不变量](#运行时不变量)

## Tool 接口

```ts
interface Tool {
  name: string;
  description: string;
  parameters?: Record<string, any>;
  execute(args: any, context?: any): Promise<any>;
  render?: ToolRenderConfig;
  executionMode?: 'normal' | 'exclusive';
  parallelizable?: boolean;
}
```

使用 `createTool()` 统一字符串渲染简写和执行标记：

```ts
const tool = createTool({
  name: 'record_get',
  description: '按 ID 读取一条记录。',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: '记录 ID。' } },
    required: ['id'],
    additionalProperties: false,
  },
  parallelizable: true,
  execute: async ({ id }, context) => readRecord(String(id), context?.signal),
});
```

## 工具准备

`getTools()` 返回构造时可确定的工具。保持可重复调用、名称集合稳定且不执行外部 I/O。

`getAsyncTools(ctx)` 连接或发现动态能力。异常会被核心记录，准备流程继续到 `onInitiate()`，因此 Feature 需要 readiness。

`ctx.registerTool(tool)` 可在发现过程中立即注册。不要再从返回数组返回同名工具。

所有注册最终进入 ToolRegistry，以工具名作为唯一当前键，并保留 superseded 历史。

## 单工具执行顺序

每个工具调用经过：

```text
lookup tool
→ disabled check
→ Agent forward onToolUse
→ Feature ToolUse guard decisions
→ context injectors
→ add signal and continuation sink
→ tool.execute
→ normalize success/error
→ Agent forward onToolFinished
→ Feature ToolFinished hooks
```

未找到、disabled、forward hook 阻止或 Feature hook Deny 都会形成失败结果，并触发 ToolFinished 通知。

## 执行上下文

工具 context 由浅合并产生：

1. 按注册顺序合并所有匹配 injector；
2. 加入当前 call 的 `signal`；
3. 加入 `registerContinuationRequest()`。

工具不能假设存在 `context.agent`、`context.feature` 或 `context.workspaceDir`。需要的值由 Feature 注入或闭包提供。

```ts
execute: async (args, context) => {
  const runtime = context?.recordFeature as RecordRuntime | undefined;
  if (!runtime) throw new Error('record feature context is unavailable');
  return runtime.update(args, context?.signal);
}
```

## 结果转换

工具返回字符串时直接写入 tool message；其他值通过 `JSON.stringify()` 转换。由此要求：

- 结果可 JSON 序列化；
- 不返回 `undefined` 作为成功主结果；
- 不返回 BigInt、循环引用、客户端或函数；
- 结果体积有界；
- 自定义类先转换为普通对象。

工具执行成功但结果无法序列化时，最终会表现为工具失败。为结果结构写序列化测试。

抛出的异常被转换为 `{ error: message }`。`AbortError` 归一化为中断错误。

## 独占与并发

`executionMode: 'exclusive'` 表示该 assistant turn 只能有这一项工具调用。批次中只要出现独占工具且调用数大于一，整批不执行。

`parallelizable: true` 的工具先并发执行，其余工具随后串行。结果始终按原始 tool call 顺序写回。

disabled 工具仍在 LLM 可见工具列表中，但执行被拒绝。removed 工具不进入 LLM 工具列表。

## Continuation

工具通过 context 登记：

```ts
context?.registerContinuationRequest?.({
  kind: 'checkpoint',
  checkpointId: id,
});
```

一个 `onCall()` 只能登记一个 request；第二次登记会抛错。登记成功后，本 step 的工具结果先写入 Context，随后 call 以 `finishReason: 'continuation'` 结束。

宿主在 call 返回后一次性消费：

```ts
const request = agent.consumeContinuationRequest();
```

控制工具标记为 exclusive，避免同批工具登记多个请求或与其他副作用交织。

## 运行时不变量

- 工具参数始终按不可信输入处理。
- 工具成功结果必须可序列化。
- disabled 与 removed 不可混用。
- context 字段使用 Feature 专属命名空间。
- 安全关键 hook 异常不能依赖 registry 自动阻止。
- 并发工具不共享可变写状态。
- 中断信号必须传到底层操作。
- 外部写入具备幂等或冲突检测。
- 控制工具只登记 continuation，不在执行栈内替换 runtime。
