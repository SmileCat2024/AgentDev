import { describe, it, expect } from 'vitest';
import { ClawDebugClient } from '../src/core/claw-debug-client.js';

describe('ClawDebugClient runtime registration identity', () => {
  it('serializes WorkThread identity as metadata distinct from the Viewer session address', async () => {
    const requests: Array<{ url: string; body: any }> = [];
    const client = new ClawDebugClient({
      runtimeUrl: 'http://claw.test',
      processId: 'proc-1',
      fetchImpl: async (input, init) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({ url, body });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const viewerSessionId = await client.registerAgent({
      agentId: 'viewer-agent',
      name: 'Coder',
      runtimeInstanceId: 'runtime-1',
      sessionId: 'work-session-7',
      threadId: 'thread-4',
      headGeneration: 9,
    });

    const registration = requests.find((request) => request.url.endsWith('/api/sessions/register'))?.body;
    expect(viewerSessionId).toBe('proc-1:viewer-agent');
    expect(registration.sessionId).toBe(viewerSessionId);
    expect(registration.metadata).toMatchObject({
      runtimeInstanceId: 'runtime-1',
      workSessionId: 'work-session-7',
      threadId: 'thread-4',
      headGeneration: 9,
    });
    expect(registration.metadata.workSessionId).not.toBe(registration.sessionId);
  });
});
