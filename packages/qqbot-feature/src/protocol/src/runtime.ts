import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setQQBotRuntime(next: PluginRuntime) {
  runtime = next;
}

export function hasQQBotRuntime(): boolean {
  return runtime !== null;
}

export function tryGetQQBotRuntime(): PluginRuntime | null {
  return runtime;
}

export function getQQBotRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("QQBot runtime not initialized");
  }
  return runtime;
}
