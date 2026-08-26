import type { IncomingMessage, ServerResponse } from 'http';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport as StreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import type { AgentLogsResponse, AgentSession, DebugLogEntry, HookInspectorSnapshot } from '@agentdevjs/core';

const QUERY_LOGS_DEFAULT_UNBOUNDED_LIMIT = 200;

export interface DebuggerAgentSummary {
  id: string;
  name: string;
  createdAt: number;
  lastActive: number;
  connected: boolean;
  messageCount: number;
  toolCount: number;
  logCount: number;
  hasHookInspector: boolean;
}

export interface DebuggerAgentDetails extends DebuggerAgentSummary {
  projectRoot?: string;
  currentStateType?: string | null;
  pendingInputCount: number;
  hookInspector?: HookInspectorSnapshot;
}

export interface DebuggerLogQuery {
  scope?: 'current' | 'all';
  agentId?: string | null;
  level?: string;
  namespace?: string;
  feature?: string;
  lifecycle?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
  search?: string;
}

export interface DebuggerMCPDataSource {
  listAgents(): DebuggerAgentSummary[];
  getAgent(agentId: string): DebuggerAgentDetails | undefined;
  getHooks(agentId: string): HookInspectorSnapshot | undefined;
  queryLogs(query: DebuggerLogQuery): AgentLogsResponse;
}

export const DEBUGGER_MCP_TOOL_DEFINITIONS = [
  {
    name: 'list_agents',
    description: 'List all debugger-visible agents and basic session status.',
  },
  {
    name: 'get_agent',
    description: 'Get a single agent by id. Supports "self".',
  },
  {
    name: 'get_hooks',
    description: 'Get the hook inspector snapshot for an agent.',
  },
  {
    name: 'query_logs',
    description: 'Query structured logs. Prefer adding filters to narrow results; unfiltered queries are auto-truncated.',
  },
] as const;

export const DEBUGGER_MCP_RESOURCE_DEFINITIONS = [
  {
    uri: 'debug://agents',
    description: 'All visible debugger agents.',
  },
  {
    uri: 'debug://agents/{agentId}',
    description: 'Detailed agent session snapshot for a specific agent.',
  },
  {
    uri: 'debug://agents/{agentId}/hooks',
    description: 'Hook inspector snapshot for a specific agent.',
  },
] as const;

export const DEBUGGER_MCP_PROMPT_DEFINITIONS = [
  {
    name: 'analyze_errors',
    description: 'Summarize recent error logs for an agent and suggest likely causes.',
  },
  {
    name: 'review_hooks',
    description: 'Review an agent hook snapshot and identify ordering or binding issues.',
  },
  {
    name: 'diagnose_agent',
    description: 'Produce a high-level diagnosis from the current agent snapshot, hooks, and recent warnings/errors.',
  },
] as const;

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function createTextResult<T extends Record<string, unknown>>(text: string, structuredContent?: T) {
  return structuredContent
    ? {
        content: [{ type: 'text' as const, text }],
        structuredContent,
      }
    : {
        content: [{ type: 'text' as const, text }],
      };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class DebuggerMCPServer {
  constructor(private readonly dataSource: DebuggerMCPDataSource) {}

  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const server = this.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };

    res.on('close', () => {
      void close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      if (!res.writableEnded) {
        await close();
      }
    }
  }

  private createServer(): McpServer {
    const server = new McpServer(
      {
        name: 'agentdev-debugger',
        version: '0.1.0',
      },
      {
        capabilities: {
          logging: {},
        },
      }
    );

    this.registerTools(server);
    this.registerResources(server);
    this.registerPrompts(server);
    return server;
  }

  private registerTools(server: McpServer): void {
    server.registerTool('list_agents', {
      title: 'List Agents',
      description: 'List all debugger-visible agents and basic session status.',
      inputSchema: z.object({}).optional(),
    }, async () => {
      const agents = this.dataSource.listAgents();
      return createTextResult(jsonText({ agents }), { agents });
    });

    server.registerTool('get_agent', {
      title: 'Get Agent',
      description: 'Get a single agent by id. Supports "self".',
      inputSchema: z.object({
        agentId: z.string().min(1).describe('Explicit Agent ID or "self" (resolves to the caller agent).'),
        callerAgentId: z.string().optional().describe('Optional caller agent id used to resolve "self".'),
      }),
    }, async ({ agentId, callerAgentId }) => {
      const resolvedAgentId = this.resolveAgentRef(agentId, callerAgentId, { required: true });
      const agent = this.dataSource.getAgent(resolvedAgentId);
      return createTextResult(jsonText({
        requestedAgentId: agentId ?? null,
        resolvedAgentId,
        agent: agent || null,
      }), {
        requestedAgentId: agentId ?? null,
        resolvedAgentId,
        agent: agent || null,
      });
    });

    server.registerTool('get_hooks', {
      title: 'Get Hooks',
      description: 'Get the hook inspector snapshot for an agent.',
      inputSchema: z.object({
        agentId: z.string().min(1).describe('Explicit Agent ID or "self" (resolves to the caller agent).'),
        callerAgentId: z.string().optional().describe('Optional caller agent id used to resolve "self".'),
      }),
    }, async ({ agentId, callerAgentId }) => {
      const resolvedAgentId = this.resolveAgentRef(agentId, callerAgentId, { required: true });
      const hooks = this.dataSource.getHooks(resolvedAgentId);
      return createTextResult(jsonText({
        requestedAgentId: agentId ?? null,
        resolvedAgentId,
        hooks: hooks || { lifecycleOrder: [], features: [], hooks: [] },
      }), {
        requestedAgentId: agentId ?? null,
        resolvedAgentId,
        hooks: hooks || { lifecycleOrder: [], features: [], hooks: [] },
      });
    });

    server.registerTool('query_logs', {
      title: 'Query Logs',
      description: 'Query structured logs. Use filters to narrow results; unfiltered queries are auto-truncated with guidance to refine.',
      inputSchema: z.object({
        agentId: z.string().min(1).optional().describe('Explicit Agent ID or "self" (resolves to the caller agent). Required with scope=current; omit only with scope=all.'),
        callerAgentId: z.string().optional().describe('Optional caller agent id used to resolve "self".'),
        scope: z.enum(['current', 'all']).optional().describe('Scope: "current" (requires agentId) or "all".'),
        level: z.string().optional().describe('Exact log level filter, for example "error" or "warn".'),
        namespace: z.string().optional().describe('Substring match on the log namespace.'),
        feature: z.string().optional().describe('Exact feature name filter.'),
        lifecycle: z.string().optional().describe('Exact lifecycle / hook stage filter.'),
        from: z.number().int().optional().describe('Inclusive start timestamp in ms.'),
        to: z.number().int().optional().describe('Inclusive end timestamp in ms.'),
        limit: z.number().int().positive().max(500).optional().describe(`Max logs to return (1-500). Defaults to ${QUERY_LOGS_DEFAULT_UNBOUNDED_LIMIT} on unfiltered queries.`),
        offset: z.number().int().min(0).optional().describe('Pagination offset. Use with limit to continue paged results.'),
        search: z.string().optional().describe('Substring search over the log message and serialized JSON payload/context.'),
      }),
    }, async (args) => {
      const scope = args.scope === 'all' ? 'all' : 'current';
      const resolvedAgentId = scope === 'current'
        ? this.resolveAgentRef(args.agentId, args.callerAgentId, { required: true })
        : this.resolveAgentRef(args.agentId, args.callerAgentId);
      const queryAgentId = resolvedAgentId || undefined;
      const result = this.dataSource.queryLogs({
        scope,
        agentId: queryAgentId,
        level: normalizeOptionalString(args.level),
        namespace: normalizeOptionalString(args.namespace),
        feature: normalizeOptionalString(args.feature),
        lifecycle: normalizeOptionalString(args.lifecycle),
        from: normalizeOptionalNumber(args.from),
        to: normalizeOptionalNumber(args.to),
        limit: normalizeOptionalNumber(args.limit),
        offset: normalizeOptionalNumber(args.offset),
        search: normalizeOptionalString(args.search),
      });
      const payload = {
        ...result,
        requestedAgentId: args.agentId ?? null,
        resolvedAgentId,
      };
      const text = result.truncation?.truncated
        ? [
            `query_logs response truncated after ${result.truncation.returnedCount} entries (available after offset: ${result.truncation.availableCount}).`,
            result.truncation.guidance || `Retry with explicit filters or pass limit/offset, for example {"limit": ${QUERY_LOGS_DEFAULT_UNBOUNDED_LIMIT}, "offset": ${result.truncation.nextOffset || result.truncation.returnedCount}}.`,
            '',
            jsonText(payload),
          ].join('\n')
        : jsonText(payload);

      return createTextResult(text, payload);
    });
  }

  private registerResources(server: McpServer): void {
    server.registerResource('agents', 'debug://agents', {
      title: 'Debugger Agents',
      description: 'All visible debugger agents.',
      mimeType: 'application/json',
    }, async () => {
      const agents = this.dataSource.listAgents();
      return {
        contents: [{
          uri: 'debug://agents',
          mimeType: 'application/json',
          text: jsonText({ agents }),
        }],
      };
    });

    server.registerResource(
      'agent-details',
      new ResourceTemplate('debug://agents/{agentId}', { list: undefined }),
      {
        title: 'Agent Details',
        description: 'Detailed agent session snapshot for a specific agent.',
        mimeType: 'application/json',
      },
      async (uri, variables) => {
        const agentId = this.stringVar(variables.agentId);
        const agent = agentId ? this.dataSource.getAgent(agentId) : undefined;
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: 'application/json',
            text: jsonText({ agentId, agent: agent || null }),
          }],
        };
      }
    );

    server.registerResource(
      'agent-hooks',
      new ResourceTemplate('debug://agents/{agentId}/hooks', { list: undefined }),
      {
        title: 'Agent Hooks',
        description: 'Hook inspector snapshot for a specific agent.',
        mimeType: 'application/json',
      },
      async (uri, variables) => {
        const agentId = this.stringVar(variables.agentId);
        const hooks = agentId ? this.dataSource.getHooks(agentId) : undefined;
        return {
          contents: [{
            uri: uri.toString(),
            mimeType: 'application/json',
            text: jsonText({
              agentId,
              hooks: hooks || { lifecycleOrder: [], features: [], hooks: [] },
            }),
          }],
        };
      }
    );
  }

  private registerPrompts(server: McpServer): void {
    server.registerPrompt('analyze_errors', {
      title: 'Analyze Errors',
      description: 'Summarize recent error logs for an agent and suggest likely causes.',
      argsSchema: {
        agentId: z.string().min(1).describe('Explicit Agent ID. Use list_agents to discover IDs.'),
      },
    }, async ({ agentId }) => {
      const resolvedAgentId = this.resolvePromptAgent(agentId);
      const agent = this.dataSource.getAgent(resolvedAgentId);
      const logs = this.dataSource.queryLogs({
        scope: 'current',
        agentId: resolvedAgentId,
        level: 'error',
        limit: 20,
      });

      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Analyze the recent debugger errors for this agent.',
              'Focus on root cause, repeated failure patterns, and concrete next checks.',
              '',
              `Requested agent: ${agentId || 'none'}`,
              `Resolved agent: ${resolvedAgentId || 'none'}`,
              '',
              'Agent snapshot:',
              jsonText(agent || null),
              '',
              'Recent error logs:',
              jsonText(logs.logs),
            ].join('\n'),
          },
        }],
      };
    });

    server.registerPrompt('review_hooks', {
      title: 'Review Hooks',
      description: 'Review an agent hook snapshot and identify ordering or binding issues.',
      argsSchema: {
        agentId: z.string().min(1).describe('Explicit Agent ID. Use list_agents to discover IDs.'),
      },
    }, async ({ agentId }) => {
      const resolvedAgentId = this.resolvePromptAgent(agentId);
      const hooks = this.dataSource.getHooks(resolvedAgentId);
      const agent = this.dataSource.getAgent(resolvedAgentId);

      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Review this debugger hook snapshot.',
              'Look for missing hooks, ordering surprises, disabled features, and likely wiring mistakes.',
              '',
              `Requested agent: ${agentId || 'none'}`,
              `Resolved agent: ${resolvedAgentId || 'none'}`,
              '',
              'Agent snapshot:',
              jsonText(agent || null),
              '',
              'Hook snapshot:',
              jsonText(hooks || { lifecycleOrder: [], features: [], hooks: [] }),
            ].join('\n'),
          },
        }],
      };
    });

    server.registerPrompt('diagnose_agent', {
      title: 'Diagnose Agent',
      description: 'Produce a high-level diagnosis from the current agent snapshot, hooks, and recent warnings/errors.',
      argsSchema: {
        agentId: z.string().min(1).describe('Explicit Agent ID. Use list_agents to discover IDs.'),
      },
    }, async ({ agentId }) => {
      const resolvedAgentId = this.resolvePromptAgent(agentId);
      const agent = this.dataSource.getAgent(resolvedAgentId);
      const hooks = this.dataSource.getHooks(resolvedAgentId);
      const logs = this.dataSource.queryLogs({
        scope: 'current',
        agentId: resolvedAgentId,
        limit: 50,
      });

      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Diagnose this agent using the debugger snapshot.',
              'Summarize health, likely bottlenecks, suspicious hook/tool wiring, and the next debugging steps.',
              '',
              `Requested agent: ${agentId || 'none'}`,
              `Resolved agent: ${resolvedAgentId || 'none'}`,
              '',
              'Agent snapshot:',
              jsonText(agent || null),
              '',
              'Hook snapshot:',
              jsonText(hooks || { lifecycleOrder: [], features: [], hooks: [] }),
              '',
              'Recent logs:',
              jsonText(logs.logs),
            ].join('\n'),
          },
        }],
      };
    });
  }

  /**
   * 解析 agent 引用。'self' 解析为 callerAgentId；'current' 伪 ID 已随服务端
   * current 语义移除，显式报错引导调用方传显式 ID；缺省返回 null（由调用方决定
   * 如何呈现"未指定"）。
   */
  private resolvePromptAgent(agentId: string | undefined): string {
    return this.resolveAgentRef(agentId, undefined, { required: true });
  }

  private resolveAgentRef(
    requestedAgentId: string | undefined,
    callerAgentId: string | undefined,
    options: { required: true },
  ): string;

  private resolveAgentRef(
    requestedAgentId: string | undefined,
    callerAgentId: string | undefined,
    options?: { required?: false },
  ): string | null;

  private resolveAgentRef(
    requestedAgentId: string | undefined,
    callerAgentId: string | undefined,
    { required = false }: { required?: boolean } = {},
  ): string | null {
    if (requestedAgentId === 'current') {
      throw new Error("the 'current' pseudo-id was removed; pass an explicit agentId or 'self'");
    }

    const resolved = requestedAgentId === 'self'
      ? callerAgentId || null
      : requestedAgentId?.trim() || null;
    if (required && !resolved) {
      throw new Error('an explicit agentId is required for this runtime-scoped operation');
    }
    return resolved;
  }

  private stringVar(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return undefined;
  }
}

export function createDebuggerAgentSummary(
  session: AgentSession,
  connected: boolean
): DebuggerAgentSummary {
  return {
    id: session.id,
    name: session.name,
    createdAt: session.createdAt,
    lastActive: session.lastActive,
    connected,
    messageCount: session.messages.length,
    toolCount: session.tools.length,
    logCount: session.logs.length,
    hasHookInspector: !!session.hookInspector,
  };
}

export function createDebuggerAgentDetails(
  session: AgentSession,
  connected: boolean
): DebuggerAgentDetails {
  const summary = createDebuggerAgentSummary(session, connected);
  return {
    ...summary,
    projectRoot: session.projectRoot,
    currentStateType: session.currentState?.type || null,
    pendingInputCount: session.inputLease ? 1 : 0,
    hookInspector: session.hookInspector,
  };
}

export function filterDebuggerLogs(
  logs: DebugLogEntry[],
  query: Omit<DebuggerLogQuery, 'scope'> & { limit?: number; offset?: number }
): DebugLogEntry[] {
  let filtered = logs;

  if (query.level) {
    filtered = filtered.filter(entry => entry.level === query.level);
  }

  if (query.namespace) {
    filtered = filtered.filter(entry => entry.namespace.includes(query.namespace!));
  }

  if (query.feature) {
    filtered = filtered.filter(entry => entry.context.feature === query.feature);
  }

  if (query.lifecycle) {
    filtered = filtered.filter(entry => entry.context.lifecycle === query.lifecycle);
  }

  if (typeof query.from === 'number') {
    filtered = filtered.filter(entry => entry.timestamp >= query.from!);
  }

  if (typeof query.to === 'number') {
    filtered = filtered.filter(entry => entry.timestamp <= query.to!);
  }

  if (query.search) {
    const keyword = query.search.toLowerCase();
    filtered = filtered.filter(entry => {
      const haystacks = [
        entry.message,
        entry.namespace,
        JSON.stringify(entry.data ?? ''),
        JSON.stringify(entry.context ?? {}),
      ];
      return haystacks.some(value => value.toLowerCase().includes(keyword));
    });
  }

  const offset = query.offset ?? 0;
  const limit = query.limit;
  return typeof limit === 'number'
    ? filtered.slice(offset, offset + limit)
    : filtered.slice(offset);
}
