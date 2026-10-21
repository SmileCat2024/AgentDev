# @agentdevjs/shell-feature

Shell execution feature for AgentDev framework.

## Installation

```bash
npm install @agentdevjs/shell-feature
```

## Usage

```typescript
import { BasicAgent } from 'agentdev';
import { ShellFeature } from '@agentdevjs/shell-feature';

const agent = new BasicAgent().use(new ShellFeature());
```

## Features

- **Bash Execution**: Execute shell commands via Git Bash
- **Background Bash** (`bash_bg` / `bg_list` / `bg_status` / `bg_watch` / `bg_tune` / `bg_write` / `bg_kill`)
- **Safe Trash**: Delete, list, and restore files safely with trash bin

## Background Bash 架构（ADR-0031）

后台 Bash 的职责分两层：

- **进程与观察（本包 `BgRegistry`）**：进程登记与进程树控制、前台预算与
  超时转后台、双节奏汇报（interval/quiet）、短结果捕获窗、输出环形缓冲与
  增量游标、完整输出落盘、关键词订阅、ready 通知、kill 与聚合策略值。
- **通用后台接入（`@agentdevjs/core` 的 `BackgroundAccess`）**：待唤醒工作
  登记/释放与 pending-work 申报（ADR-0019）、一次性待命意图（CallStart 清
  残留、StepFinish 安全边界消费）、通知排队/同接收者聚合/按接收者分组/
  投递/未送达保留与补取、终态通知送达后释放工作登记（不提前判真完成）。
  每个接入实例持有独立 access（实例唯一注册 key），多来源（shell + coder）
  与多会话互不覆盖、不串 pending/standby。

### 通知事件身份与工作身份

通知经 `createViewerUserTurnDeliver` 适配器投递到宿主 user-turn 邮箱
（HTTP 留在 shell 适配层，core 不做网络）。body 契约：

- `sourceRef` = 通知**事件**身份（`eventId`，每批次稳定唯一，可作宿主幂等
  键；同任务后续通知不会被判重吞掉）；
- `metadata.shell.taskId` = 批内末个工作 id（旧显示契约保留）；
- `metadata.shell.taskIds` = 批内全部相关任务 id（聚合不丢关联）；
- `sessionId` = 接收者会话（任务登记时经归属 access 盖戳捕获，分组与补取
  不回退"当前会话"）。

### 挂起与待命语义

- 回合自然结束时仍有未释放的工作登记（运行中，或终态但结果尚未成功投递）
  → `CallOutcome.reason = 'suspended'`，`pendingWakeups` 携带快照。
- `bg_tune then="standby"` 与 `bg_watch`（订阅即停）通过归属 access 登记
  **一次性**待命意图；StepFinish guard 消费命中才让出轮次。旧的关键词订阅
  持续产生通知，但不再驱动流程决策——用户插话的新轮次不会被未命中的旧
  watch 误停。无真实可等工作时空待命不生效；bg_tune 仅 standby 对终态/
  不存在的任务返回现状。
- 投递失败的通知滞留在 access（未送达事实），`bg_status` 补取后清账；
  带未送达事实的终态任务不会被 done 保留上限裁掉。
- 终态通知成功投递且无其余滞留事实后才释放工作登记；释放联动任务表裁剪。

### 高级用法

直接组合通用接入（如自定义后台能力）：

```typescript
import { BackgroundAccess } from '@agentdevjs/core';
import { BgRegistry, createViewerUserTurnDeliver } from '@agentdevjs/shell-feature';

const registry = new BgRegistry({ enableExitGuard: false });
const access = new BackgroundAccess({
  source: 'shell',
  sessionId, // 可选：宿主多会话拓扑下的归属声明
  deliver: createViewerUserTurnDeliver(agentId),
  aggregationWindowMs: 250,
  onWorkRelease: () => registry.trimDone(),
});
// 登记任务时必须携带 access（登记/申报/待命/通知衔接的事实源）。
registry.register(child, { command, workdir, access, intervalMs, quietAfterMs });
```

工具工厂 `createBashBgTool` / `createBgWatchTool` / `createBgTuneTool` /
`createShellCommandTool`（转后台收养路径）同样要求传入 `access`。
