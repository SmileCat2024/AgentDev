/**
 * Gateway discovery client test.
 *
 * Tests discoverGatewayServers() and gatewayServersToConfig() with a mock
 * HTTP server that mimics the Claw gateway discovery endpoint.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { discoverGatewayServers, gatewayServersToConfig } from '../../../mcp/gateway-client.js';
import { MCPFeature } from '../index.js';

let _server: any;
let _port = 0;

beforeAll(async () => {
  _server = createServer((req, res) => {
    if (req.url === '/protoclaw/mcp-gateway/servers') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        servers: [
          { id: 'filesystem', transport: 'stdio', status: 'connected', toolCount: 5, url: `http://127.0.0.1:${_port}/protoclaw/mcp-gateway/filesystem` },
          { id: 'offline-server', transport: 'stdio', status: 'error', toolCount: 0, url: `http://127.0.0.1:${_port}/protoclaw/mcp-gateway/offline-server` },
        ],
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => {
    _server.listen(0, '127.0.0.1', () => {
      _port = (_server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  if (_server) await new Promise(r => _server.close(r));
});

describe('Gateway discovery', () => {
  it('discovers connected servers and filters offline ones', async () => {
    const result = await discoverGatewayServers(`http://127.0.0.1:${_port}`);
    expect(result.origin).toBe(`http://127.0.0.1:${_port}`);
    expect(result.servers.length).toBe(1);
    expect(result.servers[0].id).toBe('filesystem');
    expect(result.servers[0].toolCount).toBe(5);
  });

  it('returns empty for unreachable origin', async () => {
    const result = await discoverGatewayServers('http://127.0.0.1:1', 1000);
    expect(result.servers.length).toBe(0);
  });

  it('converts discovered servers to MCPConfig entries', () => {
    const result = {
      origin: 'http://127.0.0.1:1420',
      servers: [
        { id: 'filesystem', transport: 'stdio', status: 'connected', toolCount: 3, url: 'http://127.0.0.1:1420/protoclaw/mcp-gateway/filesystem' },
      ],
    };
    const config = gatewayServersToConfig(result);
    expect(Object.keys(config).length).toBe(1);
    expect(config.filesystem.transport).toBe('http');
    expect(config.filesystem.url).toContain('/protoclaw/mcp-gateway/filesystem');
  });

  it('respects excludeServers filter', () => {
    const result = {
      origin: '',
      servers: [
        { id: 'a', transport: 'stdio', status: 'connected', toolCount: 1, url: 'http://a' },
        { id: 'b', transport: 'stdio', status: 'connected', toolCount: 1, url: 'http://b' },
      ],
    };
    const config = gatewayServersToConfig(result, ['a']);
    expect(Object.keys(config)).toEqual(['b']);
  });
});

describe('MCPFeature gateway config defaults', () => {
  it('enables gateway discovery when featureConfig is absent', () => {
    const feature = new MCPFeature();
    const resolved = (feature as any).resolveFeatureConfig(undefined);
    expect(resolved.enableGateway).toBe(true);
  });

  it('enables gateway discovery for an empty featureConfig object', () => {
    const feature = new MCPFeature();
    const resolved = (feature as any).resolveFeatureConfig({});
    expect(resolved.enableGateway).toBe(true);
  });

  it('keeps explicit enableGateway=false', () => {
    const feature = new MCPFeature();
    const resolved = (feature as any).resolveFeatureConfig({ enableGateway: false });
    expect(resolved.enableGateway).toBe(false);
  });
});
