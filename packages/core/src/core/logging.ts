import { AsyncLocalStorage } from 'async_hooks';
import { format, inspect } from 'util';
import { DebugHub } from './debug-hub.js';
import type { DebugLogEntry, LogContextRef, LogLevel, Notification } from './types.js';

export interface LoggerBindings extends LogContextRef {
  tags?: string[];
}

export interface Logger {
  trace(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  child(options?: LoggerBindings & { namespace?: string }): Logger;
}

interface InternalLogScope extends LogContextRef {
  namespace?: string;
  minLevel?: LogLevel;
}

const scopeStorage = new AsyncLocalStorage<InternalLogScope>();

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

let nextLogId = 1;
let consoleBridgeInstalled = false;
let bridgeReentry = false;

/**
 * Delivery contract (single write, dual sink):
 * - hub connected: push to hub (Web UI / query_logs — visible and
 *   controllable monitoring surface); stdio mirror is OFF by default so a
 *   foreground host terminal (e.g. `npm start`) stays quiet.
 *   Set AGENTDEV_LOG_CONSOLE_MIRROR=on to mirror hub-delivered logs to stdio
 *   (e.g. watching a hub-attached agent from the CLI).
 * - hub unavailable / no agent context: stdio only (headless CLI fallback).
 *
 * stdio stream routing (AGENTDEV_LOG_STREAM = 'auto' | 'stderr', default auto):
 * - auto:    trace/debug/info → stdout; warn/error → stderr
 * - stderr:  ALL levels → stderr. Headless mode treats the agent as an
 *   auditable component of other software — stdout is reserved exclusively
 *   for program output/results, logs never pollute it. Headless entry
 *   scripts are responsible for setting this env.
 *
 * Env values are read per call so config changes apply immediately (cheap
 * process.env lookup).
 */
function shouldMirrorConsoleToStdio(): boolean {
  return (process.env.AGENTDEV_LOG_CONSOLE_MIRROR ?? 'off').trim().toLowerCase() === 'on';
}

function resolveStdioStream(level: LogLevel): NodeJS.WriteStream {
  const mode = (process.env.AGENTDEV_LOG_STREAM ?? 'auto').trim().toLowerCase();
  if (mode === 'stderr') {
    return process.stderr;
  }
  return level === 'warn' || level === 'error' ? process.stderr : process.stdout;
}

export function installConsoleBridge(): void {
  if (consoleBridgeInstalled) return;
  consoleBridgeInstalled = true;

  console.log = (...args: unknown[]) => bridgeConsole('info', args);
  console.info = (...args: unknown[]) => bridgeConsole('info', args);
  console.warn = (...args: unknown[]) => bridgeConsole('warn', args);
  console.error = (...args: unknown[]) => bridgeConsole('error', args);
  console.debug = (...args: unknown[]) => bridgeConsole('debug', args);
}

function bridgeConsole(level: LogLevel, args: unknown[]): void {
  const scope = scopeStorage.getStore();
  if (!scope || bridgeReentry) {
    writeRawConsole(level, args);
    return;
  }

  bridgeReentry = true;
  try {
    const { message, data } = normalizeConsoleArgs(args);
    emitLog(level, message, data, {
      namespace: scope.namespace || 'console',
      context: scope,
    });
  } finally {
    bridgeReentry = false;
  }
}

function writeRawConsole(level: LogLevel, args: unknown[]): void {
  // Direct stream writes bypass any console patching (installConsoleBridge)
  // and make stream routing testable.
  const stream = resolveStdioStream(level);
  stream.write(format(...args) + '\n');
}

function normalizeConsoleArgs(args: unknown[]): { message: string; data?: unknown } {
  if (args.length === 0) {
    return { message: '' };
  }

  const [first, ...rest] = args;
  if (typeof first === 'string') {
    if (rest.length === 0) {
      return { message: first };
    }
    return {
      message: first,
      data: rest.length === 1 ? rest[0] : rest,
    };
  }

  return {
    message: args.map((item) => stringifyForLog(item)).join(' '),
    data: args.length === 1 ? first : args,
  };
}

function stringifyForLog(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
    return String(value);
  }
  try {
    return inspect(value, { depth: 4, breakLength: 120 });
  } catch {
    return '[unserializable]';
  }
}

function mergeTags(...tagSets: Array<string[] | undefined>): string[] | undefined {
  const merged = new Set<string>();
  for (const tags of tagSets) {
    for (const tag of tags || []) {
      if (tag) merged.add(tag);
    }
  }
  return merged.size > 0 ? Array.from(merged) : undefined;
}

function mergeScope(base: InternalLogScope | undefined, patch: InternalLogScope | undefined): InternalLogScope {
  return {
    ...(base || {}),
    ...(patch || {}),
    tags: mergeTags(base?.tags, patch?.tags),
  };
}

function createNotification(entry: DebugLogEntry): Notification {
  return {
    type: 'log.entry',
    category: 'event',
    timestamp: entry.timestamp,
    data: entry,
  };
}

function shouldDrop(level: LogLevel, scope: InternalLogScope | undefined): boolean {
  const minLevel = scope?.minLevel;
  if (!minLevel) return false;
  return LOG_LEVEL_WEIGHT[level] < LOG_LEVEL_WEIGHT[minLevel];
}

function generateLogId(): string {
  return `log-${Date.now()}-${nextLogId++}`;
}

export function getCurrentLogScope(): LogContextRef {
  return { ...(scopeStorage.getStore() || {}) };
}

export function runWithLogScope<T>(scope: LogContextRef, fn: () => T): T {
  const merged = mergeScope(scopeStorage.getStore(), scope);
  return scopeStorage.run(merged, fn);
}

export function emitLog(
  level: LogLevel,
  message: string,
  data?: unknown,
  options?: { namespace?: string; context?: LogContextRef }
): DebugLogEntry {
  const current = scopeStorage.getStore();
  const mergedContext = mergeScope(current, options?.context);
  if (shouldDrop(level, mergedContext)) {
    return {
      id: generateLogId(),
      timestamp: Date.now(),
      level,
      message,
      namespace: options?.namespace || mergedContext.namespace || 'agent',
      context: {
        ...mergedContext,
        tags: mergedContext.tags ? [...mergedContext.tags] : undefined,
      },
      data,
      delivery: {
        hub: false,
        console: false,
        reason: 'hub-unavailable',
      },
    };
  }

  const entry: DebugLogEntry = {
    id: generateLogId(),
    timestamp: Date.now(),
    level,
    message,
    namespace: options?.namespace || mergedContext.namespace || 'agent',
    context: {
      ...mergedContext,
      tags: mergedContext.tags ? [...mergedContext.tags] : undefined,
    },
    data,
    delivery: {
      hub: false,
      console: false,
      reason: 'hub-unavailable',
    },
  };

  const agentId = entry.context.agentId;
  if (!agentId) {
    entry.delivery = {
      hub: false,
      console: true,
      reason: 'no-agent-context',
    };
    writeRawConsole(level, [message, ...(data === undefined ? [] : [data])]);
    return entry;
  }

  const debugHub = DebugHub.getInstance();
  if (debugHub.isConnected()) {
    const mirror = shouldMirrorConsoleToStdio();
    entry.delivery = {
      hub: true,
      console: mirror,
      reason: 'hub',
    };
    debugHub.pushNotification(agentId, createNotification(entry));
    if (mirror) {
      writeRawConsole(level, [
        `[${entry.namespace}] ${entry.message}`,
        ...(entry.data === undefined ? [] : [entry.data]),
      ]);
    }
    return entry;
  }

  entry.delivery = {
    hub: false,
    console: true,
    reason: 'hub-unavailable',
  };
  writeLocalFallback(entry);
  return entry;
}

function writeLocalFallback(entry: DebugLogEntry): void {
  // Headless CLI output doubles as the audit trail for agents running as
  // components of other software — keep the stdio format clean. The delivery
  // reason stays available on entry.delivery for programmatic inspection.
  const prefix = `[${entry.namespace}] ${entry.message}`;
  const args = entry.data === undefined ? [prefix] : [prefix, entry.data];
  writeRawConsole(entry.level, args);
}

class BoundLogger implements Logger {
  constructor(
    private readonly namespace: string,
    private readonly bindings: LoggerBindings = {}
  ) {}

  trace(message: string, data?: unknown): void {
    emitLog('trace', message, data, { namespace: this.namespace, context: this.bindings });
  }

  debug(message: string, data?: unknown): void {
    emitLog('debug', message, data, { namespace: this.namespace, context: this.bindings });
  }

  info(message: string, data?: unknown): void {
    emitLog('info', message, data, { namespace: this.namespace, context: this.bindings });
  }

  warn(message: string, data?: unknown): void {
    emitLog('warn', message, data, { namespace: this.namespace, context: this.bindings });
  }

  error(message: string, data?: unknown): void {
    emitLog('error', message, data, { namespace: this.namespace, context: this.bindings });
  }

  child(options: LoggerBindings & { namespace?: string } = {}): Logger {
    const childNamespace = options.namespace || this.namespace;
    const mergedBindings = mergeScope(this.bindings, options);
    delete (mergedBindings as any).namespace;
    return new BoundLogger(childNamespace, mergedBindings);
  }
}

export function createLogger(namespace: string, bindings?: LoggerBindings): Logger {
  return new BoundLogger(namespace, bindings);
}
