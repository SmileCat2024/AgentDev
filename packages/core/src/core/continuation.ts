/**
 * Continuation Request 类型定义
 *
 * 控制工具（如 checkpoint、rollback）通过 registerContinuationRequest()
 * 登记一个 continuation request，使当前 onCall 在合法边界停止。
 * 宿主（如 CallArbiter）通过 consumeContinuationRequest() 消费该请求，
 * 决定是否在同一个逻辑 envelope 内启动下一个 onCall segment。
 */

/**
 * Checkpoint continuation request
 *
 * Agent 建立了一个命名检查点，希望继续执行。
 * 宿主应捕获当前 runtime snapshot 并将其与 checkpointId 关联，
 * 然后启动 continuation segment。
 */
export interface CheckpointContinuationRequest {
  kind: 'checkpoint';
  checkpointId: string;
  /** 可选附加元数据（如 Agent 的自由备注） */
  metadata?: Record<string, unknown>;
}

/**
 * Rollback continuation request
 *
 * Agent 希望回退到指定 checkpoint，并携带一个失败分支的摘要。
 * 宿主应恢复到 checkpoint 的 runtime snapshot，
 * 然后以摘要作为 continuation segment 的输入启动新的 onCall。
 */
export interface RollbackContinuationRequest {
  kind: 'rollback';
  checkpointId: string;
  /** Agent 生成的失败分支摘要 */
  summary: string;
}

/**
 * 受类型约束的 continuation request
 */
export type CallContinuationRequest =
  | CheckpointContinuationRequest
  | RollbackContinuationRequest;
