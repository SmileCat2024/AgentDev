export type DebugTransportMode = 'viewer-worker' | 'claw';

export function resolveDebugTransportMode(): DebugTransportMode {
  return process.env.AGENTDEV_DEBUG_TRANSPORT === 'claw' ? 'claw' : 'viewer-worker';
}

export function getClawRuntimeUrl(): string {
  return process.env.AGENTDEV_CLAW_RUNTIME_URL || 'http://127.0.0.1:3030';
}
