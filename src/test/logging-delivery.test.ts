import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DebugHub } from '../core/debug-hub.js';
import { emitLog, runWithLogScope } from '../core/logging.js';
import { ViewerWorker } from '../core/viewer-worker.js';

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-logging-delivery-${process.pid}-${Date.now()}`;
  }
  return `/tmp/agentdev-logging-delivery-${process.pid}-${Date.now()}.sock`;
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 3000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe('Logging delivery fallback', () => {
  it('should fall back to console when hub is unavailable', () => {
    const debugHub = DebugHub.getInstance();
    debugHub.stop();

    const entry = runWithLogScope({
      agentId: 'agent-fallback',
      agentName: 'FallbackAgent',
      namespace: 'agent.test',
    }, () => emitLog('info', 'fallback log'));

    expect(entry.delivery.console).toBe(true);
    expect(entry.delivery.hub).toBe(false);
    expect(entry.delivery.reason).toBe('hub-unavailable');
  });
});

describe('Logging delivery hub', () => {
  const debugHub = DebugHub.getInstance();
  let worker: ViewerWorker;
  let originalUdsPath: string | undefined;
  const udsPath = getTestUdsPath();

  beforeAll(async () => {
    debugHub.stop();
    originalUdsPath = process.env.AGENTDEV_UDS_PATH;
    process.env.AGENTDEV_UDS_PATH = udsPath;
    (debugHub as any).udsPath = udsPath;

    worker = new ViewerWorker(0, false, udsPath);
    await worker.start();
    await debugHub.start(0, false);
  });

  afterAll(async () => {
    debugHub.stop();
    await worker.stop();

    if (originalUdsPath === undefined) {
      delete process.env.AGENTDEV_UDS_PATH;
    } else {
      process.env.AGENTDEV_UDS_PATH = originalUdsPath;
    }
  });

  it('should deliver to hub when connected and preserve delivery metadata', async () => {
    const agentId = debugHub.registerAgent({ kind: 'dummy' }, 'LoggingDeliveryAgent');

    await waitFor(() => !!(worker as any).agentSessions.get(agentId));

    const deliveredEntry = runWithLogScope({
      agentId,
      agentName: 'LoggingDeliveryAgent',
      namespace: 'agent.test',
    }, () => emitLog('info', 'hub log', { ok: true }));

    expect(deliveredEntry.delivery.hub).toBe(true);
    expect(deliveredEntry.delivery.console).toBe(false);
    expect(deliveredEntry.delivery.reason).toBe('hub');

    await waitFor(() => {
      const session = (worker as any).agentSessions.get(agentId);
      return !!session && Array.isArray(session.logs) && session.logs.some((entry: { message: string }) => entry.message === 'hub log');
    });

    const session = (worker as any).agentSessions.get(agentId);
    const stored = session.logs.find((entry: { message: string }) => entry.message === 'hub log');
    expect(stored?.delivery?.hub).toBe(true);

    debugHub.unregisterAgent(agentId);
  });
});
