import { getClawRuntimeUrl, resolveDebugTransportMode, type DebugTransportMode } from './debug-transport.js';

export interface DebugCapabilities {
  transportMode: DebugTransportMode;
  interactiveInput: boolean;
  runtimeUrl: string | null;
  viewerCompatibleApi: boolean;
  debuggerMcpMetadata: boolean;
}

export function getDebugCapabilities(): DebugCapabilities {
  const transportMode = resolveDebugTransportMode();
  const isClaw = transportMode === 'claw';

  return {
    transportMode,
    interactiveInput: true,
    runtimeUrl: isClaw ? getClawRuntimeUrl() : null,
    viewerCompatibleApi: isClaw,
    debuggerMcpMetadata: isClaw,
  };
}
