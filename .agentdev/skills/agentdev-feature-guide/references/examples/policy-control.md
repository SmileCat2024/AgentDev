# 范例：安全策略与控制流工具

## 安全策略 Feature

```ts
import {
  Decision,
  ToolUse,
  type AgentFeature,
  type DecisionResult,
  type FeatureInitContext,
  type ToolContext,
} from 'agentdev';

interface PermissionService {
  canWrite(resourceId: string, signal?: AbortSignal): Promise<boolean>;
}

export class WritePolicyFeature implements AgentFeature {
  readonly name = 'write-policy';
  readonly description = '在记录写入前验证资源范围和写权限。';

  private logger?: FeatureInitContext['logger'];

  constructor(private readonly permissions: PermissionService) {}

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
  }

  static hooks = {
    decideWrite: { lifecycle: CoreLifecycle.ToolUse, kind: 'guard' as const, role: 'policy' as const },
  };

  async decideWrite(ctx: ToolContext): Promise<DecisionResult> {
    if (ctx.call.name !== 'record_update') return Decision.Continue;

    const resourceId = typeof ctx.call.arguments.resourceId === 'string'
      ? ctx.call.arguments.resourceId.trim()
      : '';
    if (!resourceId) {
      return { action: Decision.Deny, reason: 'resourceId 不能为空' };
    }

    ctx.call.arguments.resourceId = resourceId;

    try {
      const allowed = await this.permissions.canWrite(resourceId);
      return allowed
        ? Decision.Continue
        : { action: Decision.Deny, reason: `没有资源 ${resourceId} 的写权限` };
    } catch (error) {
      this.logger?.error('Permission check failed', {
        resourceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        action: Decision.Deny,
        reason: '权限服务不可用，已阻止写操作。',
      };
    }
  }

  getHookDescription(lifecycle: string, methodName: string): string | undefined {
    return lifecycle === 'ToolUse' && methodName === 'decideWrite'
      ? '验证 record_update 的资源范围和写权限；校验失败时关闭放行。'
      : undefined;
  }
}
```

允许时返回 `Continue`，保留后续安全 Feature 的判断机会。异常在内部转换为 `Deny`，避免 registry 的异常继续语义造成放行。

## 控制流工具

```ts
import { createTool, type AgentFeature, type Tool } from 'agentdev';

export class CheckpointRequestFeature implements AgentFeature {
  readonly name = 'checkpoint-request';
  readonly description = '请求宿主在 call 边界创建或回退命名检查点。';

  getTools(): Tool[] {
    return [
      createTool({
        name: 'checkpoint_request_create',
        description: '请求创建命名检查点。必须作为本轮唯一工具调用。',
        executionMode: 'exclusive',
        parameters: {
          type: 'object',
          properties: {
            checkpointId: {
              type: 'string',
              description: '稳定且不含敏感信息的检查点 ID。',
              minLength: 1,
              maxLength: 100,
            },
          },
          required: ['checkpointId'],
          additionalProperties: false,
        },
        execute: async ({ checkpointId }, context) => {
          const id = String(checkpointId).trim();
          if (!id) return { ok: false, error: 'checkpointId 不能为空' };
          context?.registerContinuationRequest?.({
            kind: 'checkpoint',
            checkpointId: id,
          });
          return { ok: true, checkpointId: id };
        },
      }),
      createTool({
        name: 'checkpoint_request_rollback',
        description: '请求回退到命名检查点。必须作为本轮唯一工具调用。',
        executionMode: 'exclusive',
        parameters: {
          type: 'object',
          properties: {
            checkpointId: { type: 'string', description: '已有检查点 ID。' },
            summary: { type: 'string', description: '回退后交给下一段 call 的简短摘要。' },
          },
          required: ['checkpointId', 'summary'],
          additionalProperties: false,
        },
        execute: async ({ checkpointId, summary }, context) => {
          context?.registerContinuationRequest?.({
            kind: 'rollback',
            checkpointId: String(checkpointId).trim(),
            summary: String(summary).trim(),
          });
          return { ok: true, checkpointId };
        },
      }),
    ];
  }
}
```

宿主在 `onCall()` 返回后调用 `consumeContinuationRequest()`，再执行 `createNamedCheckpoint()` 或 `rollbackToNamedCheckpoint()`。一个 call 只能登记一个 request。

验收：独占批次、参数边界、单 request 限制、工具结果先写入 Context、`finishReason: 'continuation'`、宿主消费后清空、回退不伪装撤销外部副作用。
