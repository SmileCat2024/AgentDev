/**
 * Gateway discovery client — discovers Claw-hosted MCP servers
 * and converts them into standard MCPConfig entries for transparent mounting.
 *
 * When an agent runs under Claw, PROTOCLAW_SERVER_ORIGIN is set in the env.
 * This module fetches the gateway discovery endpoint, filters to connected
 * servers, and returns MCPConfig entries pointing to the gateway proxy URLs.
 */

import type { MCPServerConfig } from './types.js';

export interface GatewayServerInfo {
  id: string;
  transport: string;
  status: string;
  toolCount: number;
  url: string;
}

export interface GatewayDiscoveryResult {
  origin: string;
  servers: GatewayServerInfo[];
}

/**
 * Discover available gateway servers from Claw's MCP Gateway.
 * Returns empty servers array if gateway is unavailable.
 * Never throws — failures are silently swallowed.
 */
export async function discoverGatewayServers(
  origin?: string,
  timeoutMs = 3000
): Promise<GatewayDiscoveryResult> {
  const gatewayOrigin = origin || process.env.PROTOCLAW_SERVER_ORIGIN;
  if (!gatewayOrigin) {
    return { origin: '', servers: [] };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${gatewayOrigin}/protoclaw/mcp-gateway/servers`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { origin: gatewayOrigin, servers: [] };
    }
    const data = await res.json();
    const servers = (Array.isArray(data.servers) ? data.servers : []) as GatewayServerInfo[];
    // Only return servers that have tools (connected and discovered)
    return {
      origin: gatewayOrigin,
      servers: servers.filter(s => s.toolCount > 0),
    };
  } catch {
    // Gateway not available — silently skip
    return { origin: gatewayOrigin || '', servers: [] };
  }
}

/**
 * Convert discovered gateway servers into MCPConfig server entries.
 * Each gateway server becomes an HTTP transport pointing to the gateway proxy URL.
 */
export function gatewayServersToConfig(
  discovery: GatewayDiscoveryResult,
  excludeServers?: string[]
): Record<string, MCPServerConfig> {
  const servers: Record<string, MCPServerConfig> = {};
  for (const server of discovery.servers) {
    if (excludeServers?.includes(server.id)) {
      continue;
    }
    servers[server.id] = {
      transport: 'http',
      url: server.url,
    };
  }
  return servers;
}
