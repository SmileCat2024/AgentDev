import type { IncomingMessage, ServerResponse } from 'http';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import type { AgentLogsResponse, AgentSession, DebugLogEntry, HookInspectorSnapshot } from './types.js';

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
  currentAgentId?: string | null;
  selectedAgentId?: string | null;
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
  getCurrentAgentId(): string | null;
  getHooks(agentId: string): HookInspectorSnapshot | undefined;
  queryLogs(query: DebuggerLogQuery): AgentLogsResponse;
}

export const DEBUGGER_MCP_TOOL_DEFINITIONS = [
  {
    name: 'list_agents',
    description: 'List all debugger-visible agents and basic session status.',
  },
  {
    name: 'get_current_agent',
    description: 'Get the currently selected agent in the debugger.',
  },
  {
    name: 'get_agent',
    description: 'Get a single agent by id. Supports "current" and "self".',
  },
  {
    name: 'get_hooks',
    description: 'Get the hook inspector snapshot for an agent.',
  },
  {
    name: 'query_logs',
    description: 'Query structured debugger logs with agent, level, namespace, lifecycle, feature, and time filters.',
  },
] as const;

export const DEBUGGER_MCP_RESOURCE_DEFINITIONS = [
  {
    uri: 'debug://agents',
    description: 'All visible debugger agents.',
  },
  {
    uri: 'debug://agents/current',
    description: 'Currently selected agent in the debugger.',
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

    server.registerTool('get_current_agent', {
      title: 'Get Current Agent',
      description: 'Get the currently selected agent in the debugger.',
      inputSchema: z.object({}).optional(),
    }, async () => {
      const currentAgentId = this.dataSource.getCurrentAgentId();
      const agent = currentAgentId ? this.dataSource.getAgent(currentAgentId) : undefined;
      return createTextResult(jsonText({ currentAgentId, agent: agent || null }), {
        currentAgentId,
        agent: agent || null,
      });
    });

    server.registerTool('get_agent', {
      title: 'Get Agent',
      description: 'Get a single agent by id. Supports "current" and "self".',
      inputSchema: z.object({
        agentId: z.string().optional().describe('Agent ID, "current", or "self". Defaults to current.'),
        callerAgentId: z.string().optional().describe('Optional caller agent id used to resolve "self".'),
      }),
    }, async ({ agentId, callerAgentId }, extra) => {
      const resolvedAgentId = this.resolveAgentRef(agentId, callerAgentId, extra);
      const agent = resolvedAgentId ? this.dataSource.getAgent(resolvedAgentId) : undefined;
      return createTextResult(jsonText({
        requestedAgentId: agentId || 'current',
        resolvedAgentId,
        agent: agent || null,
      }), {
        requestedAgentId: agentId || 'current',
        resolvedAgentId,
        agent: agent || null,
      });
    });

    server.registerTool('get_hooks', {
      title: 'Get Hooks',
      description: 'Get the hook inspector snapshot for an agent.',
      inputSchema: z.object({
        agentId: z.string().optional().describe('Agent ID, "current", or "self". Defaults to current.'),
        callerAgentId: z.string().optional().describe('Optional caller agent id used to resolve "self".'),
      }),
    }, async ({ agentId, callerAgentId }, extra) => {
      const resolvedAgentId = this.resolveAgentRef(agentId, callerAgentId, extra);
      const hooks = resolvedAgentId ? this.dataSource.getHooks(resolvedAgentId) : undefined;
      return createTextResult(jsonText({
        requestedAgentId: agentId || 'current',
        resolvedAgentId,
        hooks: hooks || { lifecycleOrder: [], features: [], hooks: [] },
      }), {
        requestedAgentId: agentId || 'current',
        resolvedAgentId,
        hooks: hooks || { lifecycleOrder: [], features: [], hooks: [] },
      });
    });

    server.registerTool('query_logs', {
      title: 'Query Logs',
      description: 'Query structured debugger logs with agent, level, namespace, lifecycle, feature, and time filters.',
      inputSchema: z.object({
        agentId: z.string().optional().describe('Agent ID, "current", "self", or omitted.'),
        callerAgentId: z.string().optional().describe('Optional caller agent id used to resolve "self".'),
        scope: z.enum(['current', 'all']).optional().describe('Query current agent or all agents.'),
        level: z.string().optional(),
        namespace: z.string().optional(),
        feature: z.string().optional(),
        lifecycle: z.string().optional(),
        from: z.number().int().optional().describe('Inclusive start timestamp in ms.'),
        to: z.number().int().optional().describe('Inclusive end timestamp in ms.'),
        limit: z.number().int().positive().max(500).optional().describe('Maximum number of logs to return.'),
        offset: z.number().int().min(0).optional().describe('Pagination offset.'),
        search: z.string().optional().describe('Substring search over log message and JSON data.'),
      }),
    }, async (args, extra) => {
      const resolvedAgentId = this.resolveAgentRef(args.agentId, args.callerAgentId, extra);
      const scope = args.scope === 'all' ? 'all' : 'current';
      const result = this.dataSource.queryLogs({
        scope,
        agentId: resolvedAgentId,
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

      return createTextResult(jsonText({
        ...result,
        requestedAgentId: args.agentId || 'current',
        resolvedAgentId,
      }), {
        ...result,
        requestedAgentId: args.agentId || 'current',
        resolvedAgentId,
      });
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

    server.registerResource('current-agent', 'debug://agents/current', {
      title: 'Current Agent',
      description: 'Currently selected agent in the debugger.',
      mimeType: 'application/json',
    }, async () => {
      const currentAgentId = this.dataSource.getCurrentAgentId();
      const agent = currentAgentId ? this.dataSource.getAgent(currentAgentId) : undefined;
      return {
        contents: [{
          uri: 'debug://agents/current',
          mimeType: 'application/json',
          text: jsonText({ currentAgentId, agent: agent || null }),
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
        agentId: z.string().optional().describe('Agent ID, "current", or "self". Defaults to current.'),
      },
    }, async ({ agentId }) => {
      const resolvedAgentId = this.resolvePromptAgent(agentId);
      const agent = resolvedAgentId ? this.dataSource.getAgent(resolvedAgentId) : undefined;
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
              `Requested agent: ${agentId || 'current'}`,
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
        agentId: z.string().optional().describe('Agent ID, "current", or "self". Defaults to current.'),
      },
    }, async ({ agentId }) => {
      const resolvedAgentId = this.resolvePromptAgent(agentId);
      const hooks = resolvedAgentId ? this.dataSource.getHooks(resolvedAgentId) : undefined;
      const agent = resolvedAgentId ? this.dataSource.getAgent(resolvedAgentId) : undefined;

      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Review this debugger hook snapshot.',
              'Look for missing hooks, ordering surprises, disabled features, and likely wiring mistakes.',
              '',
              `Requested agent: ${agentId || 'current'}`,
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
        agentId: z.string().optional().describe('Agent ID, "current", or "self". Defaults to current.'),
      },
    }, async ({ agentId }) => {
      const resolvedAgentId = this.resolvePromptAgent(agentId);
      const agent = resolvedAgentId ? this.dataSource.getAgent(resolvedAgentId) : undefined;
      const hooks = resolvedAgentId ? this.dataSource.getHooks(resolvedAgentId) : undefined;
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
              `Requested agent: ${agentId || 'current'}`,
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

  private resolvePromptAgent(agentId: string | undefined): string | null {
    if (!agentId || agentId === 'current' || agentId === 'self') {
      return this.dataSource.getCurrentAgentId();
    }
    return agentId;
  }

  private resolveAgentRef(
    requestedAgentId: string | undefined,
    callerAgentId: string | undefined,
    extra: { requestInfo?: unknown }
  ): string | null {
    const fromHeader = this.getRequestHeader(extra.requestInfo, 'x-agentdev-agent-id');
    const fallbackAgentId = callerAgentId || fromHeader;

    if (!requestedAgentId || requestedAgentId === 'current') {
      return this.dataSource.getCurrentAgentId();
    }

    if (requestedAgentId === 'self') {
      return fallbackAgentId || this.dataSource.getCurrentAgentId();
    }

    return requestedAgentId;
  }

  private stringVar(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return undefined;
  }

  private getRequestHeader(requestInfo: unknown, name: string): string | undefined {
    const headers = (requestInfo as { headers?: Headers } | undefined)?.headers;
    if (!headers || typeof headers.get !== 'function') {
      return undefined;
    }
    return headers.get(name) || undefined;
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
  const pendingInputRequests = (session as any).pendingInputRequests as Map<string, unknown> | undefined;
  return {
    ...summary,
    projectRoot: session.projectRoot,
    currentStateType: session.currentState?.type || null,
    pendingInputCount: pendingInputRequests?.size || 0,
    hookInspector: session.hookInspector,
  };
}

export function filterDebuggerLogs(
  logs: DebugLogEntry[],
  query: Omit<DebuggerLogQuery, 'scope' | 'currentAgentId' | 'selectedAgentId'> & { limit?: number; offset?: number }
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
