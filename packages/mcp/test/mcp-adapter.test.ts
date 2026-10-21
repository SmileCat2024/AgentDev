import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { BasicAgent, isWithImagesResult } from '@agentdevjs/core';
import type { Message } from '@agentdevjs/core';
import { MCPToolAdapter } from '../src/mcp-adapter.js';
import { MCPClient } from '../src/client.js';
import { MCPFeature } from '../src/feature/index.js';

vi.mock('os', async (importOriginal) => ({
  ...await importOriginal<typeof import('os')>(),
  homedir: vi.fn(),
}));

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==';
const image = { type: 'image', data: PNG, mimeType: 'image/png' };

describe('MCP image results', () => {
  let home: string;
  let storageDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(os.tmpdir(), 'mcp-images-'));
    storageDir = join(home, 'host-images');
    vi.mocked(os.homedir).mockReturnValue(home);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  function adapter(result: unknown, directory = storageDir) {
    return new MCPToolAdapter(
      { name: 'preview', handler: async () => result },
      { serverName: 'photocraft', storageDir: directory },
    );
  }

  it('routes MCP images through withImages without Base64 in result text or snapshot', async () => {
    const result = await adapter({
      content: [{ type: 'text', text: 'preview' }, image],
      structuredContent: { width: 1, height: 1 },
    }).execute({});

    expect(isWithImagesResult(result)).toBe(true);
    if (!isWithImagesResult(result)) throw new Error('Missing image envelope');
    expect(JSON.parse(result.text)).toEqual({
      content: 'preview', server: 'photocraft', duration: expect.any(Number),
      structuredContent: { width: 1, height: 1 },
    });
    expect(JSON.stringify(result)).not.toContain(PNG);
    const hash = createHash('sha256').update(PNG).digest('hex').slice(0, 32);
    expect(result.images).toEqual([{
      path: join(storageDir, `${hash}.png`), mediaType: 'image/png',
      source: 'photocraft/preview image 1',
    }]);
    expect(readFileSync(result.images[0].path!)).toEqual(Buffer.from(PNG, 'base64'));
  });

  it('keeps image-only results and multiple images in order, reusing identical snapshots', async () => {
    const tool = adapter({ content: [image, { ...image, mimeType: 'image/jpeg' }, image] });
    const first = await tool.execute({});
    const second = await tool.execute({});
    expect(isWithImagesResult(first)).toBe(true);
    expect(isWithImagesResult(second)).toBe(true);
    if (!isWithImagesResult(first) || !isWithImagesResult(second)) throw new Error('Missing image envelope');
    expect(first.images).toHaveLength(3);
    expect(first.images[1].path).toMatch(/\.jpg$/);
    expect(first.images[2].path).toBe(first.images[0].path);
    expect(second.images).toEqual(first.images);
    expect(readdirSync(storageDir)).toHaveLength(2);
    expect(JSON.parse(first.text).content).toBe('');
  });

  it('restores a damaged content-addressed snapshot rather than referencing wrong bytes', async () => {
    const tool = adapter({ content: [image] });
    const first = await tool.execute({});
    if (!isWithImagesResult(first)) throw new Error('Missing image envelope');
    writeFileSync(first.images[0].path!, 'damaged');
    await tool.execute({});
    expect(readFileSync(first.images[0].path!)).toEqual(Buffer.from(PNG, 'base64'));
  });

  it('uses the read_image default directory when no host directory is supplied', async () => {
    const result = await new MCPToolAdapter(
      { name: 'preview', handler: async () => ({ content: [image] }) },
      { serverName: 'photocraft' },
    ).execute({});
    if (!isWithImagesResult(result)) throw new Error('Missing image envelope');
    expect(result.images[0].path).toContain(join(home, '.agentdev', 'images'));
  });

  it('preserves existing text, structured content and resource behavior without images', async () => {
    const resource = { type: 'resource', uri: 'test:document', mimeType: 'text/plain', text: 'resource' };
    const result = await adapter({
      content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }, resource],
      structuredContent: { ok: true },
    }).execute({});
    expect(isWithImagesResult(result)).toBe(false);
    expect(result).toEqual({
      content: 'one\ntwo', server: 'photocraft', duration: expect.any(Number),
      structuredContent: { ok: true },
      resources: [{ uri: 'test:document', mimeType: 'text/plain', text: 'resource' }],
    });
    expect(readdirSync(home)).toEqual([]);
  });

  it('preserves resource metadata alongside image attachments', async () => {
    const result = await adapter({ content: [image, { type: 'resource', uri: 'test:doc', text: 'notes' }] }).execute({});
    if (!isWithImagesResult(result)) throw new Error('Missing image envelope');
    expect(JSON.parse(result.text).resources).toEqual([{ uri: 'test:doc', text: 'notes' }]);
  });

  it('preserves the existing isError response even when it contains an image', async () => {
    const result = await adapter({ isError: true, content: [{ type: 'text', text: 'failed' }, image] }).execute({});
    expect(result).toEqual({
      success: false, error: 'failed\n', server: 'photocraft', duration: expect.any(Number),
    });
    expect(readdirSync(home)).toEqual([]);
  });

  it('reports storage failure instead of silently falling back to Base64', async () => {
    writeFileSync(storageDir, 'not a directory');
    const result = await adapter({ content: [image] }).execute({});
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('[MCP Error]') });
    expect(isWithImagesResult(result)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(PNG);
  });

  it('delivers attachments through the real agent executor into context and the next LLM call', async () => {
    const tool = adapter({ content: [{ type: 'text', text: 'preview' }, image] });
    let calls = 0;
    let delivered: Message | undefined;
    const agent = new BasicAgent({
      name: 'mcp-image-test',
      llm: {
        async chat(messages) {
          if (calls++ === 0) return { content: '', toolCalls: [{ id: 'preview_1', name: tool.name, arguments: {} }] };
          delivered = messages.find(message => message.role === 'tool');
          return { content: 'done' };
        },
      },
    });
    agent.getTools().register(tool);
    try {
      await agent.onCall('inspect preview');
      expect(delivered?.images).toHaveLength(1);
      expect(delivered?.images?.[0].path).toContain(storageDir);
      expect(delivered?.content).not.toContain(PNG);
      expect(readFileSync(delivered!.images![0].path!)).toEqual(Buffer.from(PNG, 'base64'));
    } finally {
      await agent.dispose();
    }
  });

  it('rejects unsupported MIME types without using them as a filesystem extension', async () => {
    const result = await adapter({ content: [{ ...image, mimeType: 'image/svg+xml' }] }).execute({});
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Unsupported MCP image MIME type') });
    expect(readdirSync(home)).toEqual([]);
  });

  it('passes the host storage directory through feature mounting and tool creation', async () => {
    vi.spyOn(MCPClient.prototype, 'listTools').mockResolvedValue([{ name: 'preview' }]);
    vi.spyOn(MCPClient.prototype, 'callTool').mockResolvedValue({ content: [image] });
    vi.spyOn(MCPClient.prototype, 'dispose').mockResolvedValue();
    const feature = new MCPFeature(
      { servers: { photocraft: { transport: 'http', url: 'http://unused.invalid/mcp' } } },
      { storageDir },
    );
    try {
      const tools = await feature.getAsyncTools({} as any);
      expect(tools).toHaveLength(1);
      const result = await tools[0].execute({});
      if (!isWithImagesResult(result)) throw new Error('Missing image envelope');
      expect(result.images[0].path).toContain(storageDir);
      expect(readFileSync(result.images[0].path!)).toEqual(Buffer.from(PNG, 'base64'));
    } finally {
      await feature.onDestroy();
    }
  });
});
