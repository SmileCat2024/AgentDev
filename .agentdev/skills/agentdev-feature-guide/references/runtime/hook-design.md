# Hook 规则设计与错误策略

## 目录

- [规则分类](#规则分类)
- [决策组合](#决策组合)
- [异常语义](#异常语义)
- [Context 修改](#context-修改)
- [状态机](#状态机)
- [性能与可观测性](#性能与可观测性)
- [验证](#验证)

## 规则分类

将 hook 规则分为：

- 安全准入：权限、路径、租户、危险操作；
- 参数标准化：trim、默认值、兼容输入；
- 工作流控制：继续、结束、等待；
- 状态同步：计数、标志、审计记录；
- Context 注入：提醒、外部事件摘要；
- 观测：结构化日志和指标。

一个决策方法可以组合多个纯规则，但不要混入远端业务执行和复杂资源创建。

## 决策组合

ToolUse 和 StepFinish 的 guard 钩子建议每个 Feature 只声明一个方法，规则在方法内逐个短路：

```ts
import {
  CoreLifecycle,
  Decision,
  normalizeDecision,
  type HookDeclarations,
  type DecisionResult,
  type ToolContext,
} from 'agentdev';

static hooks: HookDeclarations = {
  decideTool: {
    lifecycle: CoreLifecycle.ToolUse,
    kind: 'guard' as const,
    role: 'advisor' as const,
  },
};

async decideTool(ctx: ToolContext): Promise<DecisionResult> {
  for (const rule of this.toolRules) {
    const result = await rule(ctx);
    if (normalizeDecision(result) !== Decision.Continue) return result;
  }
  return Decision.Continue;
}
```

跨 Feature 执行顺序：同生命周期的 guard 先按 `policy → advisor` 分区（组内保持注册序），第一个 `Approve` 或 `Deny` 停止后续决策钩子：

- `Deny` 用于明确阻止；
- `Approve` 用于明确允许并停止后续规则；
- `Continue` 用于不抢占，让后续规则判断。

安全策略通常返回 `Continue` 表示“本规则未阻止”，不要轻易返回 `Approve` 跳过后续安全 Feature。

## 异常语义

反向 hook 抛出的异常会被 registry 记录，然后继续执行后续 hook；所有规则都未给出强决策时，流程采用默认行为。

因此安全关键 ToolUse guard 必须在自身内部决定失败策略：

```ts
try {
  return await this.checkPermission(ctx);
} catch (error) {
  this.logger.error('Permission check failed', { error: toMessage(error) });
  return {
    action: Decision.Deny,
    reason: '权限校验暂时不可用，已阻止该操作。',
  };
}
```

明确选择：

- fail-closed：安全、权限、额度和数据边界检查失败时拒绝；
- fail-open：纯观测、非关键提示失败时允许继续；
- degraded：注入可见提示并限制到只读能力。

不要依赖抛异常实现安全阻止。

## Context 修改

- CallStart 钩子改写输入时读 `ctx.agent.getUserInput()`；
- StepStart 钩子只注入本 step 必需信息；
- ToolUse guard 可以标准化 `ctx.call.arguments`，工具仍要校验；
- ToolFinished 钩子只处理已经发生的结果；
- 注入消息设置清晰 role，避免伪造用户输入；
- 大对象先摘要，不把日志或数据库结果整批塞入 Context。

为重复提醒维护 revision 或 lastInjectedStep，确保同一信息只在需要时出现。

## 状态机

StepFinish guard 的继续条件写成有限状态机：

```ts
if (state.phase === 'waiting' && state.pendingCount > 0) {
  if (state.continuations >= MAX_CONTINUATIONS) return Decision.Deny;
  state.continuations += 1;
  return Decision.Approve;
}
return Decision.Continue;
```

状态机必须具备：

- 进入条件；
- 每次继续消耗的状态；
- 完成条件；
- 最大连续次数；
- 中断和错误出口；
- capture/restore 字段。

## 性能与可观测性

hook 位于高频路径。避免每个 step 或工具调用都：

- 重新读取大文件；
- 建立网络连接；
- 扫描完整历史 Context；
- 写入同步数据库大事务；
- 输出完整参数或响应。

日志记录 lifecycle、方法名、规则名称、决策和简短 reason。`getHookDescription()` 为 inspector 提供稳定说明。

## 验证

- 每个规则的 Continue/Approve/Deny；
- 多规则短路顺序；
- 跨 Feature 注册顺序；
- 安全检查异常时 fail-closed；
- 通知 hook 异常不会改变主流程；
- 参数标准化后工具收到正确值；
- 重复提醒不会膨胀 Context；
- `StepFinish` 有明确最大次数和退出测试；
- 继承覆盖同名方法时 registry 调用子类实现。
