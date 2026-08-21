import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DebugHub } from '@agentdev/core';
import { emitLog, runWithLogScope } from '@agentdev/core';
import { ViewerWorker } from '../src/viewer-worker.js';

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

  it('routes info to stdout and warn/error to stderr in auto mode', () => {
    const debugHub = DebugHub.getInstance();
    debugHub.stop();

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stdout.write as any) = (chunk: any) => { stdoutLines.push(String(chunk)); return true; };
    (process.stderr.write as any) = (chunk: any) => { stderrLines.push(String(chunk)); return true; };

    try {
      runWithLogScope({
        agentId: 'agent-stream-auto',
        agentName: 'StreamAuto',
        namespace: 'agent.test',
      }, () => {
        emitLog('info', 'auto info log');
        emitLog('warn', 'auto warn log');
      });
    } finally {
      (process.stdout.write as any) = originalStdoutWrite;
      (process.stderr.write as any) = originalStderrWrite;
    }

    expect(stdoutLines.some((line) => line.includes('auto info log'))).toBe(true);
    expect(stdoutLines.some((line) => line.includes('auto warn log'))).toBe(false);
    expect(stderrLines.some((line) => line.includes('auto warn log'))).toBe(true);
    expect(stderrLines.some((line) => line.includes('auto info log'))).toBe(false);
  });

  it('routes all levels to stderr when AGENTDEV_LOG_STREAM=stderr (headless audit contract)', () => {
    const debugHub = DebugHub.getInstance();
    debugHub.stop();

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    (process.stdout.write as any) = (chunk: any) => { stdoutLines.push(String(chunk)); return true; };
    (process.stderr.write as any) = (chunk: any) => { stderrLines.push(String(chunk)); return true; };

    process.env.AGENTDEV_LOG_STREAM = 'stderr';
    try {
      runWithLogScope({
        agentId: 'agent-stream-headless',
        agentName: 'StreamHeadless',
        namespace: 'agent.test',
      }, () => {
        emitLog('info', 'headless info log');
        emitLog('error', 'headless error log');
      });
    } finally {
      delete process.env.AGENTDEV_LOG_STREAM;
      (process.stdout.write as any) = originalStdoutWrite;
      (process.stderr.write as any) = originalStderrWrite;
    }

    // stdout reserved exclusively for program output/results
    expect(stdoutLines.some((line) => line.includes('headless'))).toBe(false);
    expect(stderrLines.some((line) => line.includes('headless info log'))).toBe(true);
    expect(stderrLines.some((line) => line.includes('headless error log'))).toBe(true);
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

  it('should deliver to hub only by default (quiet terminal), preserving delivery metadata', async () => {
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

  it('should mirror hub-delivered logs to console when AGENTDEV_LOG_CONSOLE_MIRROR=on', async () => {
    const agentId = debugHub.registerAgent({ kind: 'dummy' }, 'LoggingDeliveryMirrorAgent');

    await waitFor(() => !!(worker as any).agentSessions.get(agentId));

    process.env.AGENTDEV_LOG_CONSOLE_MIRROR = 'on';
    try {
      const deliveredEntry = runWithLogScope({
        agentId,
        agentName: 'LoggingDeliveryMirrorAgent',
        namespace: 'agent.test',
      }, () => emitLog('warn', 'mirrored log'));

      expect(deliveredEntry.delivery.hub).toBe(true);
      expect(deliveredEntry.delivery.console).toBe(true);
      expect(deliveredEntry.delivery.reason).toBe('hub');
    } finally {
      delete process.env.AGENTDEV_LOG_CONSOLE_MIRROR;
    }

    debugHub.unregisterAgent(agentId);
  });
});
