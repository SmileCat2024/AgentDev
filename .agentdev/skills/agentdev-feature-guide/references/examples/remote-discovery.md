# 范例：远端发现与可清理资源

```ts
import {
  createTool,
  type AgentFeature,
  type FeatureContext,
  type FeatureInitContext,
  type Tool,
} from 'agentdev';

interface RemoteAction {
  id: string;
  description: string;
  readOnly: boolean;
}

interface RemoteClient {
  listActions(signal?: AbortSignal): Promise<RemoteAction[]>;
  invoke(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

interface RemoteFeatureOptions {
  connect(ctx: FeatureInitContext): Promise<RemoteClient>;
  allowedActions: readonly string[];
}

type Readiness =
  | { state: 'starting' }
  | { state: 'ready'; toolCount: number }
  | { state: 'degraded'; reason: string }
  | { state: 'stopped' };

function normalizeName(id: string): string {
  const value = id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!value) throw new Error(`无法从远端动作生成工具名: ${id}`);
  return `remote_${value}`;
}

export class RemoteFeature implements AgentFeature {
  readonly name = 'remote';
  readonly description = '发现并调用配置范围内的远端动作。';

  private client?: RemoteClient;
  private readiness: Readiness = { state: 'starting' };
  private readonly toolNames = new Set<string>();

  constructor(private readonly options: RemoteFeatureOptions) {}

  getStatus(): Readonly<Readiness> {
    return { ...this.readiness };
  }

  getDiscoveredToolNames(): readonly string[] {
    return [...this.toolNames];
  }

  getTools(): Tool[] {
    return [];
  }

  async getAsyncTools(ctx: FeatureInitContext): Promise<Tool[]> {
    let client: RemoteClient | undefined;
    try {
      client = await this.options.connect(ctx);
      const actions = await client.listActions();
      const allowed = new Set(this.options.allowedActions);
      const names = new Set<string>();

      const tools = actions.flatMap(action => {
        if (!allowed.has(action.id)) return [];
        const name = normalizeName(action.id);
        if (names.has(name)) throw new Error(`远端动作名称冲突: ${name}`);
        names.add(name);

        return [createTool({
          name,
          description: [
            action.description.trim() || `执行远端动作 ${action.id}。`,
            action.readOnly ? '该操作只读。' : '该操作可能修改远端状态。',
            '参数会作为对象传给远端动作，返回可序列化结果。',
          ].join('\n'),
          parameters: {
            type: 'object',
            properties: {
              input: {
                type: 'object',
                description: '远端动作参数。只提供该动作明确需要的字段。',
              },
            },
            required: ['input'],
            additionalProperties: false,
          },
          parallelizable: action.readOnly,
          execute: async ({ input }, context) => {
            if (this.readiness.state !== 'ready' || !this.client) {
              throw new Error(`remote feature is not ready: ${this.readiness.state}`);
            }
            return this.client.invoke(
              action.id,
              input as Record<string, unknown>,
              context?.signal,
            );
          },
        })];
      });

      this.client = client;
      this.toolNames.clear();
      for (const name of names) this.toolNames.add(name);
      this.readiness = { state: 'ready', toolCount: tools.length };
      ctx.logger.info('Remote actions discovered', { toolCount: tools.length });
      return tools;
    } catch (error) {
      await client?.close().catch(() => undefined);
      this.readiness = {
        state: 'degraded',
        reason: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.readiness = { state: 'stopped' };
    await client?.close();
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    await this.stop();
  }
}
```

动态移除前显式处理异步工具：

```ts
const feature = agent.getFeature<RemoteFeature>('remote');
if (feature) {
  for (const name of feature.getDiscoveredToolNames()) {
    agent.getTools().remove(name);
  }
  await feature.stop();
  agent.removeFeature('remote');
}
```

验收：白名单过滤、确定性命名、碰撞检测、只读并发、失败后关闭局部 client、未就绪错误、动态工具追踪、重复 stop 和动态移除前 awaited stop。
