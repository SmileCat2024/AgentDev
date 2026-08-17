# Feature 排障清单

## 目录

- [工具没有出现](#工具没有出现)
- [工具被同名覆盖](#工具被同名覆盖)
- [Feature Hook 没有执行](#feature-hook-没有执行)
- [决策 Hook 冲突](#决策-hook-冲突)
- [安全 Hook 抛错后工具仍执行](#安全-hook-抛错后工具仍执行)
- [初始化失败后 Hook 仍执行](#初始化失败后-hook-仍执行)
- [Step 无法结束](#step-无法结束)
- [工具上下文为空](#工具上下文为空)
- [中断后副作用仍在继续](#中断后副作用仍在继续)
- [独占工具整批失败](#独占工具整批失败)
- [并发工具发生竞态](#并发工具发生竞态)
- [Feature 配置没有生效](#feature-配置没有生效)
- [工作区路径错误](#工作区路径错误)
- [模板回退到 JSON](#模板回退到-json)
- [Feature Skills 没有发现](#feature-skills-没有发现)
- [快照恢复不完整](#快照恢复不完整)
- [外部资源恢复后不可用](#外部资源恢复后不可用)
- [动态移除后仍有行为](#动态移除后仍有行为)
- [日志在终端可见但调试器不可见](#日志在终端可见但调试器不可见)
- [测试写法与仓库不一致](#测试写法与仓库不一致)

## 工具没有出现

按顺序检查：

1. Feature 是否通过 `agent.use()` 或 `agent.mountFeature()` 注册。
2. `getTools()` 是否返回数组。
3. 工具是否有 `name`、`description` 和异步 `execute`。
4. `getAsyncTools()` 是否抛错；检查初始化日志。
5. 工具是否被 `remove()` 或预移除；disabled 工具仍会发给 LLM，只在执行时被阻止。
6. 是否有后注册的同名工具覆盖它。
7. Agent 是否已经执行 Feature 准备阶段。

让 `getTools()` 保持无外部副作用并可重复调用，避免第二次调用时返回不同工具集合。

## 工具被同名覆盖

ToolRegistry 以工具名为键。后注册的同名工具成为生效项，旧工具在 inspector 中显示为 `superseded`。

处理方法：

- 为不同语义使用不同工具名；
- 明确 Feature 注册顺序；
- 自定义 Agent 的统一覆盖工具放在 `onFeatureToolsReady()`；
- 查看 inspector 中每个工具的 `source`。

不要依赖偶然的 import 顺序决定业务行为。

## Feature Hook 没有执行

检查：

1. 方法名是否出现在 `static hooks` 声明中——没有声明的方法不会被调用。
2. 声明的方法名与实际方法名拼写一致（`method_missing` / `method_not_function` 装配错误）。
3. kind 与 lifecycle 组合是否合法（guard 只能 ToolUse / StepFinish，transform 只能 ToolResultTransform）。
4. Feature 是否在准备阶段完成 hook 收集。
5. 动态替换时旧实例是否仍在 registry。
6. 方法名是否在子类中被错误覆盖为非函数字段。
7. inspector 中该钩子条目的 `enabled` 是否为 true（可能被禁用）。

Feature 的一次性资源初始化使用 `onInitiate()`，不是普通的 Agent forward hook 同名方法。

## 决策 Hook 冲突

同一生命周期的 guard 按 `policy → advisor` 排序执行，第一个 `Approve` / `Deny` 短路后续 guard。每个生命周期的 `role: 'policy'` 至多一个，出现两个会在装配时报 `duplicate_policy` 错误。

将多个规则组合进一个方法：

```ts
static hooks: HookDeclarations = {
  decide: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard' as const, role: 'advisor' as const },
};

async decide(ctx: ToolContext) {
  const decisions = [
    await this.checkPermission(ctx),
    await this.checkScope(ctx),
  ];
  return decisions.find(value => value !== Decision.Continue)
    ?? Decision.Continue;
}
```

继承已有钩子方法时覆盖父方法（声明从父类继承），不要重复声明同名生命周期的新方法。

## 安全 Hook 抛错后工具仍执行

反向 hook 的异常会被记录并跳过，registry 会继续执行后续 hook；没有强决策时采用默认行为。

安全关键 ToolUse guard 在方法内部捕获权限、策略和审计错误，并显式返回 `Decision.Deny`。不要用抛异常表达阻止。

允许当前规则通过但仍需后续 Feature 判断时返回 `Decision.Continue`，不要返回会短路后续规则的 `Decision.Approve`。

## 初始化失败后 Hook 仍执行

`getAsyncTools()` 和 `onInitiate()` 的异常会被记录，随后准备流程仍可能继续并收集 hooks。

修复：

- 维护 `starting | ready | degraded | stopped` 就绪状态；
- 工具和 hooks 在使用客户端前检查 readiness；
- 安全 hook 未就绪时采用明确 fail-closed；
- 初始化失败时释放已创建的局部资源；
- 测试每个部分初始化失败点。

## Step 无法结束

常见原因：

- StepFinish guard 无条件返回 `Decision.Approve`；
- 待办状态从未被清空；
- 每个 step 注入提醒后又把自己标记为待处理；
- 外部事件不断补充 pending buffer；
- Agent 的最大 step 设置为无限且没有退出条件。

修复：

- 把续跑条件写成显式状态机；
- 每次续跑消耗一个状态；
- 添加最大连续续跑次数；
- 为停止条件写测试；
- 记录每次返回 `Approve` 的原因。

## 工具上下文为空

除框架注入的 `signal` 和 `registerContinuationRequest` 外，业务上下文来自 `getContextInjectors()`。

检查：

1. Feature 是否实现注入器。
2. 字符串或正则是否匹配工具名。
3. 注入器是否在 `agent.use(feature)` 时可返回。
4. 工具读取的字段结构是否与注入结果一致。
5. 正则是否使用了 `g` / `y` 导致 `lastIndex` 改变。

不要假设 `context.agent` 或 `context.feature` 自动存在。

## 中断后副作用仍在继续

框架可以停止等待工具，但底层操作只有在响应 `AbortSignal` 时才真正停止。

修复：

- 将 `context.signal` 传给 `fetch`、SDK 或子进程封装；
- 长循环主动检查 `signal.aborted`；
- 写操作设计幂等键和提交边界；
- 中断后重新读取外部真实状态；
- 不把“Agent 已返回 interrupted”理解为外部操作一定撤销。

## 独占工具整批失败

一个 turn 同时包含独占工具和其他工具时，整个批次都会被拒绝。

工具描述中明确写“必须作为本轮唯一工具调用”，并设置：

```ts
executionMode: 'exclusive'
```

让 Agent 下一轮只重试该工具。不要在 Feature hook 中偷偷执行被拒绝批次里的其他操作。

## 并发工具发生竞态

`parallelizable: true` 的工具会同时执行。常见竞态：

- 修改同一个 Feature 数组或 Map；
- 写同一个文件；
- 更新同一个远端对象；
- 一个工具依赖另一个工具先完成。

修复：去掉并发标记，或把任务拆成独立资源。并发只适合可证明互不影响的操作。

## Feature 配置没有生效

manifest 只声明配置形状，不会自动写入 Feature 字段。

检查：

1. `AgentConfig.features` 的键是否等于 `feature.name`。
2. `onInitiate(ctx)` 是否读取 `ctx.featureConfig`。
3. 解析函数是否处理 `unknown`、空值和默认值。
4. 构造参数与 featureConfig 的优先级是否明确。
5. 配置改变后是否重建了依赖旧配置的客户端。

不要直接把未验证的 `ctx.featureConfig` 断言成完整配置类型。

## 工作区路径错误

症状：Feature 在错误目录读取文件、找不到 `.agentdev`、模板路径异常。

检查：

- 用户文件操作是否基于 `ctx.config.workspaceDir`；
- 包和模板资源是否基于 `projectRoot` / package root；
- 构造函数是否把 `process.cwd()` 固化成了错误目录；
- Windows 路径是否经过 `fileURLToPath()` 和规范化；
- 相对配置路径是否只在一个明确基准上解析。

## 模板回退到 JSON

按顺序检查：

1. 工具的 `render` 名称。
2. `getTemplateNames()` 是否包含名称。
3. `getPackageInfo()` 是否返回正确包根。
4. 模板是否进入 tsup entry。
5. `dist/templates/name.render.js` 是否存在。
6. Feature 模板是否 `export default`。
7. 模板名是否误带 `.render.js`。
8. 调试宿主是否读取了正确项目根。
9. 是否重建并重启持有模板缓存的进程。

内联模板应直接放在 `Tool.render`；只实现 `getRenderTemplates()` 不会自动改变默认包模板交付链。

## Feature Skills 没有发现

检查：

1. Agent 是否挂载名为 `skill` 的 Feature。
2. 业务 Feature 是否设置 `source`。
3. 内置 Feature 的 skills 是否位于构建后入口同级 `skills/`。
4. 独立包是否包含 `dist/skills/`。
5. `package.json.files` 是否发布 skills 产物。
6. SKILL.md frontmatter 是否包含 `name` 和 `description`。
7. 是否被工作区同名 skill 覆盖。

## 快照恢复不完整

检查：

- 是否同时实现 `captureState()` 与 `restoreState()`；
- 是否遗漏影响行为的字段；
- Set/Map 是否转换为数组或普通对象；
- restore 是否完整覆盖旧状态，而不是只追加；
- 是否错误共享了可变引用；
- 继承时是否调用了父类 capture/restore；
- 输入校验是否把合法的 `false`、`0` 或空数组误判为缺失。

为快照写往返测试：`state → capture → new instance → restore → equivalent state`。

## 外部资源恢复后不可用

快照恢复的是逻辑状态，不是旧进程中的连接。

正确结构：

- `onInitiate()` 创建 client、socket、worker；
- `restoreState()` 恢复纯数据；
- 需要时根据恢复状态重新订阅或重新加载；
- 无法恢复的实时任务明确清空或标记为待重建。

不要把客户端实例、活动 Promise 或子进程句柄放入 snapshot。

## 动态移除后仍有行为

可能来源：

- Feature 自己启动的轮询器没有停止；
- 异步注册的工具没有被追踪；
- 外部事件监听器没有解绑；
- 同名旧实例的 context injector 仍存在；
- 在已运行 Agent 中直接用 `use()` 覆盖了旧实例。

为动态 Feature 设计显式清理：保存 timer、controller、listener 和动态工具名，并在 `onDestroy()` 全部释放。替换时使用明确的 remove + mount 流程。

`removeFeature()` 不等待异步 `onDestroy()` 完成。如果后续操作依赖资源已经彻底关闭，为 Feature 提供一个可等待的公开 `stop()`，先 `await feature.stop()`，再移除。

## 日志在终端可见但调试器不可见

调试面板和日志查询读取成功交付给 DebugHub 的结构化日志。Hub 不可用时，日志可以回退到本地 console，但不会自动补入后续查询。

优先使用 `ctx.logger`，并检查日志产生时 Agent 是否已连接调试宿主。不要把 Context 消息当作日志缓冲区。

## 测试写法与仓库不一致

AgentDev 源码仓库使用 Vitest：

```ts
import { describe, expect, it } from 'vitest';
```

Feature 测试位于：

```text
src/features/<feature>/test/**/*.test.ts
```

不要套用独立脚本式 `main().catch()` 测试模板。独立 npm Feature 包使用该包自己的测试配置，并确保测试命令能在干净安装后运行。
