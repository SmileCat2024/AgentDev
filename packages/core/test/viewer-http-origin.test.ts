import { describe, it, expect, afterEach, vi } from 'vitest';
import { Agent } from '../src/core/agent.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';

/**
 * ADR-0037 决策 3：runtime → 平台 HTTP 面（dequeue-input）寻址配置化。
 *
 * - AGENTDEV_VIEWER_ORIGIN 注入时优先（容器/远程部署，runtime 与平台不在
 *   同一网络命名空间）；
 * - 未注入时回退现状：本机回环 + AGENTDEV_VIEWER_PORT（测试经 setup.ts
 *   全局指向不存在端口，防探测真实服务）；
 * - PROTOCLAW_INTERNAL_TOKEN 存在时携带 Bearer（回环模式服务端不校验，
 *   与 TCP 控制通道共用同一 token 体系）。
 */

/** 每次都发起工具调用的 LLM：配合 maxTurns=1 构造 step 边界，保证 dequeue 探测发生。 */
class AlwaysToolCallLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return {
      content: '',
      toolCalls: [{ id: 't1', name: 'definitely_not_registered_tool', arguments: {} }],
    };
  }
}

/** 捕获 dequeue-input 请求的 URL 与 Authorization 头；其余 fetch 一律失败。 */
function stubDequeueFetch(): Array<{ url: string; authorization?: string }> {
  const seen: Array<{ url: string; authorization?: string }> = [];
  vi.stubGlobal('fetch', async (url: unknown, init?: unknown) => {
    if (String(url).includes('/dequeue-input')) {
      const headers = (init as { headers?: Record<string, string> } | undefined)?.headers;
      seen.push({ url: String(url), authorization: headers?.Authorization });
      return { ok: true, json: async () => ({ input: null, remaining: 0 }) };
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  });
  return seen;
}

async function driveOneCall() {
  const agent = new Agent({ llm: new AlwaysToolCallLLM(), maxTurns: 1 });
  await agent.onCall('执行任务');
}

describe('viewer HTTP face addressing (ADR-0037 decision 3)', () => {
  const savedOrigin = process.env.AGENTDEV_VIEWER_ORIGIN;
  const savedToken = process.env.PROTOCLAW_INTERNAL_TOKEN;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedOrigin === undefined) delete process.env.AGENTDEV_VIEWER_ORIGIN;
    else process.env.AGENTDEV_VIEWER_ORIGIN = savedOrigin;
    if (savedToken === undefined) delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    else process.env.PROTOCLAW_INTERNAL_TOKEN = savedToken;
  });

  it('dequeue uses AGENTDEV_VIEWER_ORIGIN when injected', async () => {
    process.env.AGENTDEV_VIEWER_ORIGIN = 'http://192.0.2.10:2526';
    const seen = stubDequeueFetch();

    await driveOneCall();

    expect(seen.length).toBeGreaterThan(0);
    for (const req of seen) {
      expect(req.url.startsWith('http://192.0.2.10:2526/api/agents/')).toBe(true);
    }
  });

  it('falls back to loopback + AGENTDEV_VIEWER_PORT when origin absent', async () => {
    delete process.env.AGENTDEV_VIEWER_ORIGIN;
    const seen = stubDequeueFetch();

    await driveOneCall();

    // setup.ts 已把 AGENTDEV_VIEWER_PORT 指向不存在端口（默认 '1'）
    const expectedPort = process.env.AGENTDEV_VIEWER_PORT || '2026';
    expect(seen.length).toBeGreaterThan(0);
    for (const req of seen) {
      expect(req.url.startsWith(`http://127.0.0.1:${expectedPort}/api/agents/`)).toBe(true);
    }
  });

  it('sends Bearer from PROTOCLAW_INTERNAL_TOKEN when present', async () => {
    delete process.env.AGENTDEV_VIEWER_ORIGIN;
    process.env.PROTOCLAW_INTERNAL_TOKEN = 'tok-test-internal';
    const seen = stubDequeueFetch();

    await driveOneCall();

    expect(seen.length).toBeGreaterThan(0);
    for (const req of seen) {
      expect(req.authorization).toBe('Bearer tok-test-internal');
    }
  });

  it('omits Authorization header when no internal token is set', async () => {
    delete process.env.AGENTDEV_VIEWER_ORIGIN;
    delete process.env.PROTOCLAW_INTERNAL_TOKEN;
    const seen = stubDequeueFetch();

    await driveOneCall();

    expect(seen.length).toBeGreaterThan(0);
    for (const req of seen) {
      expect(req.authorization).toBeUndefined();
    }
  });
});
