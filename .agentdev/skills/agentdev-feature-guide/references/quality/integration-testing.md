# Agent 集成与交付测试

## 目录

- [测试夹具](#测试夹具)
- [Feature 准备](#feature-准备)
- [工具执行循环](#工具执行循环)
- [Hook 顺序](#hook-顺序)
- [恢复与会话](#恢复与会话)
- [动态装配](#动态装配)
- [构建消费](#构建消费)

## 测试夹具

建立可编排的假 LLM，按调用次数返回固定响应：

```ts
class ScriptedLLM implements LLMClient {
  private index = 0;
  constructor(private readonly responses: LLMResponse[]) {}

  async chat(): Promise<LLMResponse> {
    const response = this.responses[this.index++];
    if (!response) throw new Error('unexpected LLM call');
    return structuredClone(response);
  }
}
```

使用真实 `Agent`、`Context`、ToolRegistry 和 hooks registry。只替换 LLM、外部客户端、时钟和文件系统边界。

## Feature 准备

验证：

- 注册顺序；
- 同步和异步工具来源；
- `ctx.featureConfig` 以 `feature.name` 取值；
- `ctx.registerTool()` 来源正确；
- `onInitiate()` 在异步发现后执行；
- hooks 在初始化后收集；
- `onFeatureToolsReady()` 覆盖工具的最终来源；
- 异步发现和初始化失败时 readiness 行为。

## 工具执行循环

脚本化一轮含 tool calls 的响应，再返回最终文本。断言：

- assistant tool call 进入 Context；
- 工具结果与 call ID 对齐；
- 结构化结果被正确序列化；
- disabled 工具仍可见但执行失败；
- removed 工具不发给 LLM；
- 独占违规整批拒绝；
- 并发与串行分组正确；
- 结果按原始顺序写回；
- continuation 在工具结果闭合后结束 call。

## Hook 顺序

用事件数组记录：

```ts
events.push('feature-a:tool-use');
```

覆盖：

- notification hooks 全部顺序执行；
- decision hooks 在 Approve/Deny 处短路；
- Continue 进入下一 Feature；
- hook 抛错后的实际策略；
- ToolFinished 钩子在成功、失败、禁用和阻止后执行；
- StepFinish guard 的无工具与有工具分支；
- 继承覆盖同名 hook 方法。

## 恢复与会话

- step 失败后 Context 与 Feature 状态恢复；
- before/restore/after 顺序；
- call rollback 恢复 draftInput；
- 命名 checkpoint 在 call 边界创建和回退；
- session save/load 后状态等价；
- 缺失 Feature snapshot 被安全忽略；
- 外部资源由新实例重建；
- session 文件不含客户端或 secret。

## 动态装配

- 首次 call 前 mount 延迟准备；
- 运行期 mount 立即注册；
- remove 后 hooks 消失；
- stable injector 被移除；
- 异步工具由自定义清理路径处理；
- `stop()` 在 remove 前被等待；
- 同名替换不残留旧行为；
- inspector 状态与真实工具一致。

## 构建消费

1. 执行 TypeScript 构建和测试；
2. 运行 `npm pack`；
3. 检查 tarball 文件列表；
4. 在临时空项目安装 tarball 与兼容 AgentDev；
5. 从包根 import Feature 和公开类型；
6. 创建最小 Agent 并执行 smoke call；
7. 请求模板资源；
8. 发现 Feature skills；
9. dispose 并确认进程能自然退出。

不要只从源码路径运行 smoke test。交付问题通常只在打包结果中出现。
