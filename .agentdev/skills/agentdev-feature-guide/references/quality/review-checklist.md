# Feature 代码审查与验收

## 目录

- [P0 阻断项](#p0-阻断项)
- [P1 正确性](#p1-正确性)
- [P1 安全](#p1-安全)
- [P1 生命周期](#p1-生命周期)
- [P2 契约质量](#p2-契约质量)
- [P2 可维护性](#p2-可维护性)
- [交付验收](#交付验收)

## P0 阻断项

- 工具可越过工作区、租户或权限边界。
- 写操作在重试或中断后可能重复且无幂等策略。
- 凭据进入工具结果、Context、日志、模板或快照。
- 安全 hook 抛错后默认放行。
- StepFinish guard 没有退出条件。
- 后台进程、socket 或 worker 无法停止。
- rollback 声称撤销了实际未撤销的外部副作用。
- 构建产物无法从包根导入。

## P1 正确性

- `feature.name` 与配置键、依赖查找一致。
- `getTools()` 确定且无副作用。
- 异步发现名称稳定并处理碰撞。
- 工具结果可序列化、大小有界。
- disabled 与 removed 语义使用正确。
- 独占和并发标记符合真实副作用。
- context injector 字段不冲突。
- hook 返回值符合生命周期语义。
- 配置默认值在运行时真正应用。
- capture/restore 覆盖全部逻辑状态。

## P1 安全

- 安全关键字段在执行时再次验证。
- 路径解析后检查真实允许范围。
- URL、重定向和内网目标受限。
- shell/进程使用参数数组和受控环境。
- 批量数量、输出和响应大小有限制。
- 远端文本不被直接当作 system 指令。
- 模板动态值 HTML 转义。
- 错误与日志完成脱敏。

## P1 生命周期

- 初始化失败后工具不会使用半初始化资源。
- readiness 状态覆盖 starting/ready/degraded/stopping/stopped。
- 局部初始化失败会释放已创建资源。
- onDestroy/stop 幂等。
- `Agent.dispose()` 路径经过测试。
- 动态移除前需要等待的资源有公开 stop。
- 后台 Promise 被保存并处理 rejection。
- abort 能到达底层 I/O 和子进程。

## P2 契约质量

- 工具名称能区分相近动作。
- 描述包含时机、限制、副作用和结果。
- schema 字段有 description、required 和边界。
- 业务失败提供下一步修正信息。
- 公开 API 小且返回只读值。
- manifest title、description、default 和 options 一致。
- hook description 可在 inspector 中理解。
- Feature skill 只承担跨工具工作流。

## P2 可维护性

- Feature 装配、工具、服务、配置和状态职责分离。
- 默认值只有一个语义源。
- 领域服务不依赖 Agent 和 Context。
- 外部 SDK 被适配器隔离并可替换测试。
- 复杂状态机有显式类型和转换。
- 日志字段稳定，不使用散乱 console 输出。
- 未使用接口方法没有空壳实现。
- 代码没有依赖偶然注册顺序的隐式行为。

## 交付验收

- 类型检查通过；
- 单元与 Agent 集成测试通过；
- hook、并发、独占、中断和恢复路径有测试；
- `npm pack` 文件列表正确；
- 模板、skills 和非 TS 资源存在；
- 临时消费项目可从包根导入；
- 最小 Agent smoke call 成功；
- dispose 后无残留进程；
- inspector 能看到正确来源、工具状态和 hook 顺序；
- 没有意外 superseded 工具或重复动态注册。
