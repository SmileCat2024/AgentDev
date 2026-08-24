import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import { LspClient } from '../../src/features/lsp/client.js';

function makeClient(): LspClient {
  const handle = {
    process: { stdout: new PassThrough(), stdin: new PassThrough() },
  };
  return new LspClient('test-server', handle as any, '/tmp', {
    info: () => {},
    error: () => {},
  });
}

describe('LspClient request timeout', () => {
  it('should degrade to fallback when request never settles', async () => {
    const client = makeClient();
    // 模拟语言服务器假死：请求永远不返回
    (client as any).connection = {
      sendRequest: () => new Promise(() => {}),
    };

    vi.useFakeTimers();
    try {
      const definition = client.definition('/tmp/a.ts', 0, 0);
      const references = client.references('/tmp/a.ts', 0, 0);
      const pending = Promise.all([definition, references]);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(await pending).toEqual([null, []]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('should resolve normally when server responds in time', async () => {
    const client = makeClient();
    (client as any).connection = {
      sendRequest: async () => [{ uri: 'file:///tmp/a.ts' }],
    };
    await expect(client.references('/tmp/a.ts', 0, 0)).resolves.toEqual([
      { uri: 'file:///tmp/a.ts' },
    ]);
  });

  it('should keep error-degradation semantics of the original catch paths', async () => {
    const client = makeClient();
    (client as any).connection = {
      sendRequest: async () => {
        throw new Error('server exploded');
      },
    };
    await expect(client.hover('/tmp/a.ts', 0, 0)).resolves.toBeNull();
    await expect(client.workspaceSymbol('q')).resolves.toEqual([]);
  });
});
