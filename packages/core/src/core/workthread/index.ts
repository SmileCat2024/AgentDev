/**
 * WorkThread 模块（ticket 007）— 框架层连续工作锚点 + 可选执行看板。
 *
 * 按 ADR-0002/Q4=C 拆分：
 * - 锚点层（store / inbox / core）：连续性锚点 + 接续编排状态 + hold + 指令投递。
 * - 看板层（board）：可选平行模块，执行调度状态机 / executionEvents / resume /
 *   mode，经 workThreadId 关联，永不反写锚点状态。
 *
 * 命名：框架接续链概念统一 `WorkThread` 前缀（Q6）。codex exec 事件流
 * `thread.started`（thread = 会话本身）保持原样，见 session-events.ts 术语注释。
 */

export {
  WorkThread,
  WorkThreadNotFoundError,
  WORKTHREAD_TERMINAL_STATUS,
  HANDOFF_STALE_MS,
  DEFAULT_SUCCESSION_INSTRUCTION,
} from './core.js';
export type {
  WorkThreadStartOptions,
  WorkThreadOptions,
  WorkThreadSuccessionContext,
  WorkThreadContinuationPolicy,
} from './core.js';

export { WorkThreadBoard, WORKTHREAD_BOARD_STATUSES, WORKTHREAD_BOARD_OPEN_STATUSES } from './board.js';
export type {
  WorkThreadBoardStatus,
  WorkThreadBoardMode,
  WorkThreadBoardExecutionEvent,
  WorkThreadBoardState,
  WorkThreadBoardOptions,
} from './board.js';

export {
  WorkThreadStore,
  WorkThreadRevisionConflictError,
  generateWorkThreadId,
  sanitizeWorkThreadFragment,
} from './store.js';
export type {
  WorkThreadRecord,
  WorkThreadChainEntry,
  WorkThreadPendingSuccession,
  WorkThreadStatus,
  WorkThreadLifecycleEvent,
  WorkThreadStoreOptions,
} from './store.js';

export {
  WorkThreadCommandStatus,
  WorkThreadCommandKind,
  MAX_RETAINED_TERMINAL_COMMANDS,
  createCommandRecord,
  appendCommand,
  pendingCommands,
  findCommand,
  pruneCommands,
  generateCommandId,
} from './inbox.js';
export type {
  WorkThreadCommand,
  WorkThreadCommandStatusValue,
  WorkThreadCommandStatusName,
  WorkThreadCommandKindValue,
} from './inbox.js';

export {
  WorkThreadRuntimeBridge,
  buildRuntimeKey,
  WORKTHREAD_BRIDGE_DISABLED_REASON,
  RUNTIME_NOT_ACCEPTING_REASON,
} from './bridge.js';
export type {
  WorkThreadBridge,
  WorkThreadBridgeSubmitTurnParams,
  WorkThreadDeliveryOutcome,
  WorkThreadRuntimeBridgeOptions,
} from './bridge.js';
