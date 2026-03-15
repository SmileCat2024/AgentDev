import type {
  AgentOverviewSnapshot,
  HookInspectorSnapshot,
  Message,
  Notification,
  Tool,
  UserInputRequest,
  UserInputResponse,
} from './types.js';
import { getClawRuntimeUrl } from './debug-transport.js';

type ClawEventKind =
  | 'message'
  | 'notification'
  | 'snapshot'
  | 'lifecycle'
  | 'tools'
  | 'input';

interface ClawSessionRegistration {
  sessionId: string;
  runtime: 'agentdev';
  agentName: string;
  projectRoot: string | null;
  metadata: Record<string, unknown>;
  state?: Record<string, unknown>;
}

interface ClawEventInput {
  sessionId: string;
  kind: ClawEventKind;
  payload: Record<string, unknown>;
}

export interface RegisterClawAgentInput {
  agentId: string;
  name: string;
  projectRoot?: string;
  featureTemplates?: Record<string, string>;
  hookInspector?: HookInspectorSnapshot;
  overview?: AgentOverviewSnapshot;
}

export class ClawDebugClient {
  private readonly runtimeUrl: string;
  private readonly processId: string;
  private readonly projectRoot: string;
  private readonly sessionByAgentId = new Map<string, string>();
  private readonly pendingSessionByAgentId = new Map<string, Promise<string>>();

  constructor(options: { runtimeUrl?: string; processId?: string; projectRoot?: string } = {}) {
    this.runtimeUrl = (options.runtimeUrl ?? getClawRuntimeUrl()).replace(/\/$/, '');
    this.processId = options.processId ?? String(process.pid);
    this.projectRoot = options.projectRoot ?? process.cwd();
  }

  async ping(): Promise<void> {
    await this.requestJson('/health');
  }

  async registerAgent(input: RegisterClawAgentInput): Promise<string> {
    const sessionId = `${this.processId}:${input.agentId}`;
    const existing = this.pendingSessionByAgentId.get(input.agentId);
    if (existing) {
      return existing;
    }

    const pending = (async () => {
      const registration: ClawSessionRegistration = {
        sessionId,
        runtime: 'agentdev',
        agentName: input.name,
        projectRoot: input.projectRoot ?? this.projectRoot,
        metadata: {
          adapter: 'agentdev-debug-hub',
          agentId: input.agentId,
          featureTemplates: input.featureTemplates ?? {},
        },
        state: {
          hookInspector: input.hookInspector ?? null,
          overview: input.overview ?? null,
        },
      };

      await this.requestJson('/api/sessions/register', {
        method: 'POST',
        body: JSON.stringify(registration),
      });

      this.sessionByAgentId.set(input.agentId, sessionId);

      await this.pushLifecycle(input.agentId, {
        phase: 'agent-registered',
        agentId: input.agentId,
        name: input.name,
      });

      return sessionId;
    })();

    this.pendingSessionByAgentId.set(input.agentId, pending);

    try {
      return await pending;
    } finally {
      this.pendingSessionByAgentId.delete(input.agentId);
    }
  }

  async unregisterAgent(agentId: string): Promise<void> {
    await this.pushLifecycle(agentId, {
      phase: 'agent-unregistered',
      agentId,
    });
  }

  async selectAgent(agentId: string): Promise<void> {
    const sessionId = await this.requireSessionId(agentId);
    await this.requestJson('/api/agents/current', {
      method: 'PUT',
      body: JSON.stringify({ agentId: sessionId }),
    });
  }

  async pushMessages(agentId: string, messages: Message[]): Promise<void> {
    await this.pushEvent(agentId, 'message', { messages });
  }

  async registerTools(agentId: string, tools: Tool[]): Promise<void> {
    await this.pushEvent(agentId, 'tools', { tools });
  }

  async updateInspector(agentId: string, hookInspector: HookInspectorSnapshot): Promise<void> {
    await this.pushEvent(agentId, 'snapshot', {
      scope: 'hookInspector',
      hookInspector,
    });
  }

  async updateOverview(agentId: string, overview: AgentOverviewSnapshot): Promise<void> {
    await this.pushEvent(agentId, 'snapshot', {
      scope: 'overview',
      overview,
    });
  }

  async pushNotification(agentId: string, notification: Notification): Promise<void> {
    await this.pushEvent(agentId, 'notification', { notification });
  }

  async requestUserInput(_agentId: string, request: UserInputRequest, timeout: number): Promise<UserInputResponse> {
    const agentId = _agentId;
    const requestId = `input-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await this.pushEvent(agentId, 'input', {
      requestId,
      request,
      timeout,
      status: 'pending',
    });

    const sessionId = await this.requireSessionId(agentId);
    const startedAt = Date.now();
    const pollIntervalMs = 400;

    while (true) {
      if (timeout !== Infinity && Date.now() - startedAt > timeout) {
        throw new Error(`User input timeout after ${timeout}ms`);
      }

      let response: Response;
      try {
        response = await fetch(
          `${this.runtimeUrl}/api/agents/${encodeURIComponent(sessionId)}/input-response?requestId=${encodeURIComponent(requestId)}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Unable to reach Claw runtime at ${this.runtimeUrl} while waiting for user input: ${message}`);
      }

      if (response.ok) {
        const body = await response.json();
        return body.response;
      }

      if (response.status !== 404) {
        const text = await response.text();
        throw new Error(`Input bridge request failed: ${response.status} ${response.statusText} ${text}`);
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  }

  private async pushLifecycle(agentId: string, payload: Record<string, unknown>): Promise<void> {
    await this.pushEvent(agentId, 'lifecycle', payload);
  }

  private async pushEvent(agentId: string, kind: ClawEventKind, payload: Record<string, unknown>): Promise<void> {
    const sessionId = await this.requireSessionId(agentId);
    const event: ClawEventInput = {
      sessionId,
      kind,
      payload,
    };

    await this.requestJson('/api/events', {
      method: 'POST',
      body: JSON.stringify(event),
    });
  }

  private async requireSessionId(agentId: string): Promise<string> {
    const sessionId = this.sessionByAgentId.get(agentId);
    if (!sessionId) {
      const pending = this.pendingSessionByAgentId.get(agentId);
      if (pending) {
        return pending;
      }
      throw new Error(`No Claw session registered for agentId '${agentId}'`);
    }
    return sessionId;
  }

  private async requestJson(path: string, init?: RequestInit): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${this.runtimeUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(init?.headers ?? {}),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to reach Claw runtime at ${this.runtimeUrl}: ${message}`);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Claw runtime request failed: ${response.status} ${response.statusText} ${body}`);
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }
}
