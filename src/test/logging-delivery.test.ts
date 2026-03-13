import { DebugHub } from '../core/debug-hub.js';
import { emitLog, runWithLogScope } from '../core/logging.js';
import { ViewerWorker } from '../core/viewer-worker.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

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

async function main(): Promise<void> {
  const debugHub = DebugHub.getInstance();
  debugHub.stop();

  const fallbackEntry = runWithLogScope({
    agentId: 'agent-fallback',
    agentName: 'FallbackAgent',
    namespace: 'agent.test',
  }, () => emitLog('info', 'fallback log'));

  assert(fallbackEntry.delivery.console, 'fallback log should write to console');
  assert(!fallbackEntry.delivery.hub, 'fallback log should not be delivered to hub');
  assert(fallbackEntry.delivery.reason === 'hub-unavailable', 'fallback log should explain hub unavailability');

  const originalUdsPath = process.env.AGENTDEV_UDS_PATH;
  const udsPath = getTestUdsPath();
  process.env.AGENTDEV_UDS_PATH = udsPath;
  (debugHub as any).udsPath = udsPath;

  const worker = new ViewerWorker(0, false, udsPath);
  await worker.start();

  try {
    await debugHub.start(0, false);

    const agentId = debugHub.registerAgent({ kind: 'dummy' }, 'LoggingDeliveryAgent');

    await waitFor(() => !!(worker as any).agentSessions.get(agentId));

    const deliveredEntry = runWithLogScope({
      agentId,
      agentName: 'LoggingDeliveryAgent',
      namespace: 'agent.test',
    }, () => emitLog('info', 'hub log', { ok: true }));

    assert(deliveredEntry.delivery.hub, 'connected log should be delivered to hub');
    assert(!deliveredEntry.delivery.console, 'connected log should not fall back to console');
    assert(deliveredEntry.delivery.reason === 'hub', 'connected log should report hub delivery');

    await waitFor(() => {
      const session = (worker as any).agentSessions.get(agentId);
      return !!session && Array.isArray(session.logs) && session.logs.some((entry: { message: string }) => entry.message === 'hub log');
    });

    const session = (worker as any).agentSessions.get(agentId);
    const stored = session.logs.find((entry: { message: string }) => entry.message === 'hub log');
    assert(stored?.delivery?.hub === true, 'stored hub log should preserve delivery metadata');

    debugHub.unregisterAgent(agentId);
    console.log('[PASS] logging delivery uses hub when connected and falls back locally when disconnected');
  } finally {
    debugHub.stop();
    await worker.stop();

    if (originalUdsPath === undefined) {
      delete process.env.AGENTDEV_UDS_PATH;
    } else {
      process.env.AGENTDEV_UDS_PATH = originalUdsPath;
    }
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
