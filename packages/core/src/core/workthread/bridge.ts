/**
 * WorkThreadRuntimeBridge — WorkThread Inbox → head runtime 的最后一跳
 *
 * 移植自 Claw `server/thread-control/thread-runtime-bridge.js`。职责：把一条
 * pending 的 WorkThread 指令下沉到当前承接会话（head session）对应的 runtime。
 * 仅此而已——不运行 Agent、不判断任务完成、不理解执行调度。
 *
 * 注入契约（宿主可 stub，现有测试注入模式不破坏）：
 * - `enabled`：桥是否启用（休眠默认 false）。
 * - `resolveRuntimeViewerId(agentId, sessionId)`：runtime 存活且可接收时返回
 *   viewerAgentId，否则 null（= runtime 未就绪，指令保持 pending 由调用方重试）。
 * - `submitTurn(params)`：真实投递函数，默认 submitUserTurn。
 */

export const WORKTHREAD_BRIDGE_DISABLED_REASON = 'bridge_disabled';
export const RUNTIME_NOT_ACCEPTING_REASON = 'runtime_not_accepting';

export interface WorkThreadBridgeSubmitTurnParams {
  agentId: string;
  text: string;
  source: string;
  sourceRef: string;
  capabilityActivations?: string[];
}

export interface WorkThreadDeliveryOutcome {
  accepted: boolean;
  reason?: string;
  retryable?: boolean;
  deliveryRef?: string;
}

/** WorkThread 与 runtime 之间的投递契约（经 {thread, command} 定位目标）。 */
export interface WorkThreadBridge {
  isEnabled(): boolean;
  deliver(params: {
    thread: { agentId?: string; headSessionId?: string; threadId?: string };
    command: { commandId?: string; text?: string };
  }): Promise<WorkThreadDeliveryOutcome>;
}

export function buildRuntimeKey(agentId: string, sessionId: string): string {
  return `${agentId}::${sessionId}`;
}

export interface WorkThreadRuntimeBridgeOptions {
  enabled?: boolean;
  resolveRuntimeViewerId?: ((agentId: string, sessionId: string) => string | null) | null;
  submitTurn?: ((params: WorkThreadBridgeSubmitTurnParams) => Promise<unknown>) | null;
}

export class WorkThreadRuntimeBridge implements WorkThreadBridge {
  private readonly _enabled: boolean;
  private readonly _resolveRuntimeViewerId: ((agentId: string, sessionId: string) => string | null) | null;
  private readonly _submitTurn: (params: WorkThreadBridgeSubmitTurnParams) => Promise<unknown>;

  constructor({
    enabled = false,
    resolveRuntimeViewerId = null,
    submitTurn = null,
  }: WorkThreadRuntimeBridgeOptions = {}) {
    this._enabled = enabled === true;
    this._resolveRuntimeViewerId =
      typeof resolveRuntimeViewerId === 'function' ? resolveRuntimeViewerId : null;
    this._submitTurn = typeof submitTurn === 'function' ? submitTurn : defaultSubmitTurn;
  }

  isEnabled(): boolean {
    return this._enabled === true;
  }

  async deliver(params: {
    thread: { agentId?: string; headSessionId?: string; threadId?: string };
    command: { commandId?: string; text?: string; capabilityActivations?: string[] };
  }): Promise<WorkThreadDeliveryOutcome> {
    const { thread, command } = params;
    if (!this.isEnabled()) {
      return { accepted: false, reason: WORKTHREAD_BRIDGE_DISABLED_REASON, retryable: true };
    }
    if (!thread?.agentId || !thread?.headSessionId) {
      return { accepted: false, reason: 'invalid_thread_target', retryable: false };
    }

    const viewerAgentId = this._resolveRuntimeViewerId
      ? this._resolveRuntimeViewerId(thread.agentId, thread.headSessionId)
      : null;
    if (!viewerAgentId) {
      // runtime 未就绪（未启动 / 正在换代 / 已停止）：指令保持 pending，
      // 由调用方在 head 推进或 runtime ready 后重试。
      return { accepted: false, reason: RUNTIME_NOT_ACCEPTING_REASON, retryable: true };
    }

    try {
      // 契约对齐：submitUserTurn 的参数名是 agentId。参数漂移会让客户端预校验
      // 抛 invalid_input（不可重试），指令被误判 failed——契约测试覆盖此点。
      await this._submitTurn({
        agentId: viewerAgentId,
        text: command.text || '',
        source: 'thread',
        sourceRef: command.commandId || '',
        ...(Array.isArray(command.capabilityActivations) && command.capabilityActivations.length > 0
          ? { capabilityActivations: command.capabilityActivations }
          : {}),
      });
    } catch (error) {
      if (isUserTurnDeliveryError(error)) {
        return {
          accepted: false,
          reason: error.code || 'delivery_failed',
          retryable: error.retryable !== false,
        };
      }
      return { accepted: false, reason: 'delivery_failed', retryable: true };
    }

    return { accepted: true, deliveryRef: viewerAgentId };
  }
}

interface UserTurnDeliveryErrorLike {
  name: string;
  code?: string;
  retryable?: boolean;
}

function isUserTurnDeliveryError(error: unknown): error is UserTurnDeliveryErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as UserTurnDeliveryErrorLike).name === 'UserTurnDeliveryError'
  );
}

/**
 * 默认 submitTurn。框架 core 域不背 HTTP 客户端依赖，真实投递由宿主经
 * `submitTurn` 注入；未注入时返回一个非重试失败，指令标记 failed。
 */
async function defaultSubmitTurn(_params: WorkThreadBridgeSubmitTurnParams): Promise<unknown> {
  const err = new Error('WorkThreadRuntimeBridge: no submitTurn provided (host must inject)');
  (err as Error & { name: string }).name = 'UserTurnDeliveryError';
  (err as Error & { code: string }).code = 'bridge_no_provider';
  (err as Error & { retryable: boolean }).retryable = false;
  throw err;
}
