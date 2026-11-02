# ADR-0001: Agent Call 启动前准入

- 状态：Accepted
- 日期：2026-11-02
- 范围：`@agentdevjs/core` 的 Agent 调用生命周期

## 背景

`Agent.onCall()` / `onCallDetailed()` 是 Agent 的正式执行入口。现有 `CallStart` 在 callIndex 递增、上下文准备、call.start 与 turn.started 事件、输入落入对话之后触发，因此只能观察或调整已经开始的 call，不能表达“这条输入不应启动”。有些策略需要在 call 启动前判断输入是否可执行；拒绝时不能留下部分 call 副作用，也不能把拒绝伪装成失败、取消或完成的 call。

框架 ReAct 循环也会在运行中的 call 内消费 ViewerWorker 排队输入并直接注入上下文；这是既有 call 内插话语义，不会创建新 call，因此不经过本 ADR 的新 call 准入点。本 ADR 只决定独立 call 是否启动。输入的排队、保留与重试由宿主持有；框架不拥有这些输入的持久化和调度策略。

## 决策

### 1. 增加真正位于启动边界之前的 `PreCallStart` guard

新增 `CoreLifecycle.PreCallStart`，只允许 `guard` 声明。框架在 Agent 串行调用队列轮到该输入时运行准入检查；通过后才进入 `executeCall`。上下文包含原始输入、输入身份选项（kind/source/sourceRef）、metadata 与 Agent 引用。缺省输入身份按现有契约解释为 `user`；框架只传递身份，不解释 reminder、人工接管等应用语义。

- 没有 guard、或最终决策为 `Continue`/`Approve`：正常进入 call。
- 最终决策为 `Deny`：抛出独立的 `CallAdmissionDeniedError`（包含拒绝原因）；不增加 callIndex、不改写会话对话、不发 call/turn 开始或结束事件、不执行 CallStart/CallFinish，也不更新 `getLastCallOutcome()`。
- `onCall()` 与 `onCallDetailed()` 对准入拒绝都抛出该类型。拒绝不是 `CallOutcome`，不改变 `onCallDetailed()` 对已执行调用的终态契约，也不返回含糊的空字符串。
- Guard 执行异常时 fail-closed：不启动 call，并将原异常交给调用方。它有权阻止执行，不能像普通观察钩子一样吞错后放行。
- 宿主需在准入成功时观测正式启动，但不得提前发出 started。`Agent.onCall*` 提供可选 `onAdmitted` 回调，在准入放行后、任何 Call 生命周期副作用前调用。它仅供宿主观察，不参与裁决；回调异常阻止 call 启动并传给调用方。

准入检查可以异步，但不得负责输入持有、排队、宿主 I/O 或业务重试。同一 Agent 的调用入口串行队列保证准入检查与实际执行顺序一致。

### 2. 输入所有权与暂缓责任留在调用方

`PreCallStart` 适用于通过 `Agent.onCall()` / `onCallDetailed()` 启动独立 call 的输入。框架 ReAct loop 在运行中的 call 内消费 ViewerWorker 邮箱输入并直接注入当前上下文，仍遵循既有的 call 内插话协议；它不是新 call，不在本 ADR 中改造。

框架不复制、缓存、持久化或重投被拒输入。拒绝说明输入尚未进入 call，不表示输入已消费。直接调用 Agent 的消费者收到拒绝异常并自行决定后续动作；有输入队列的宿主负责在原队列中保留条目、决定暂缓、改序、重试或向用户报告。宿主不得把拒绝记成已运行 call 的 completed/failed/cancelled。

因此框架提供一致的开工准入机制，但不新增第二套消息队列；每个宿主仍是其输入的唯一所有者。

### 3. 不扩大既有生命周期

`CallStart` 保持现有语义，不升级为 guard；`CallFinish`、`CallOutcome`、session events 不记录未发生的 call。现有 Feature 的 CallStart 行为不变。`PreCallStart` 是新增的窄决策点，不是“禁用 Agent 输入”的全局状态开关。

## 后果

- 通过 Agent 正式入口启动的独立 call 统一经过准入策略；运行中 call 的邮箱插话仍遵循既有协议，不在本 ADR 中改造。
- 新增生命周期 guard 必须同步接入钩子静态声明校验、生命周期检查器/Inspector 与测试。
- 所有可能遇到拒绝的宿主必须捕获 `CallAdmissionDeniedError` 并保留原输入；未捕获时调用以异常失败，但框架不会谎报 call 已开始。
- 队列公平性、优先级和待处理提示由宿主决定，框架不理解 reminder、人工接管或上下文超限。
- 后续自动接续可由应用装配另一种策略实现；本 ADR 不定义自动接续或任何业务状态机。

## 验收标准

1. 在 PreCallStart 拒绝时，callIndex、会话对话、CallOutcome、CallStart/Finish、call.start、turn.started/finished 均无变化。
2. 下次放行的调用正常执行，之前拒绝不会污染最近一次真实 CallOutcome。
3. 准入 hook 收到原始输入身份；Deny 原因可由宿主取得，hook 异常 fail-closed。
4. Claw 宿主把独立启动时被拒的 reminder 留给其原队列；人工输入可越过被暂缓提醒并先执行；人工输入获准启动时解除 Context Guard；接管后按既定队列规则继续处理 reminders。
5. 不新增框架消息存储，不改 CallStart 原有执行时序。
