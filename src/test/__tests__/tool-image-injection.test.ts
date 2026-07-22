/**
 * 工具图片注入全链路测试
 *
 * 覆盖：
 * 1. withImages() / isWithImagesResult()
 * 2. Context.addToolMessage() 图片透传
 * 3. Anthropic 编译器：tool 消息图片（视觉 / 非视觉）
 * 4. OpenAI Chat 编译器：tool 消息图片（视觉 / 非视觉）
 * 5. OpenAI Responses 编译器：tool 消息图片（视觉 / 非视觉）
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadImageTool } from '../../../packages/image-reader-feature/src/tools.js';
import { withImages, isWithImagesResult } from '../../core/tool-result-images.js';
import { Context } from '../../core/context.js';
import type { ToolExecResult } from '../../core/context.js';
import type { ToolCall, ImageInput } from '../../core/types.js';
import { compileContextForAnthropic } from '../../llm/anthropic.js';
import { compileContextForOpenAIResponses } from '../../llm/openai-responses.js';

// ---- helpers ----

function makeToolCall(id: string, name: string): ToolCall {
  return { id, name, arguments: {} };
}

const SAMPLE_IMAGE: ImageInput = {
  base64: 'iVBORw0KGgo=',
  mediaType: 'image/png',
  source: 'test.png',
};

const TOOLS = [
  {
    name: 'read_image',
    description: 'Read image',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() { return {}; },
  },
];

// ============================================================
// 1. read_image 内容快照
// ============================================================

describe('read_image managed snapshots', () => {
  it('should preserve the bytes read at tool-call time after the source changes or moves', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentdev-read-image-'));
    try {
      const workspaceDir = join(root, 'workspace');
      const storageDir = join(root, 'images');
      const sourcePath = join(root, 'source.png');
      const movedPath = join(root, 'moved.png');
      const original = Buffer.from('original-image-bytes');
      const replacement = Buffer.from('replacement-image-bytes');
      writeFileSync(sourcePath, original);

      const tool = createReadImageTool({ workspaceDir, storageDir });
      const result = await tool.execute({ path: sourcePath }, {} as any) as any;
      expect(isWithImagesResult(result)).toBe(true);
      const snapshotPath = result.images[0].path as string;
      expect(snapshotPath).not.toBe(sourcePath);
      expect(snapshotPath.startsWith(storageDir)).toBe(true);
      expect(readFileSync(snapshotPath).equals(original)).toBe(true);

      writeFileSync(sourcePath, replacement);
      renameSync(sourcePath, movedPath);

      expect(readFileSync(snapshotPath).equals(original)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('should deduplicate identical content into one managed snapshot path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentdev-read-image-dedup-'));
    try {
      const storageDir = join(root, 'images');
      const firstPath = join(root, 'first.png');
      const secondPath = join(root, 'second.png');
      const bytes = Buffer.from('same-image-bytes');
      writeFileSync(firstPath, bytes);
      writeFileSync(secondPath, bytes);

      const tool = createReadImageTool({ storageDir });
      const first = await tool.execute({ path: firstPath }, {} as any) as any;
      const second = await tool.execute({ path: secondPath }, {} as any) as any;

      expect(first.images[0].path).toBe(second.images[0].path);
      expect(first.images[0].source).toBe(firstPath);
      expect(second.images[0].source).toBe(secondPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ============================================================
// 2. withImages() / isWithImagesResult()
// ============================================================

describe('withImages()', () => {
  it('should create a WithImagesResult with marker', () => {
    const result = withImages('hello', [SAMPLE_IMAGE]);
    expect(result.__withImages).toBe(true);
    expect(result.text).toBe('hello');
    expect(result.images).toHaveLength(1);
    expect(result.images[0].source).toBe('test.png');
  });

  it('should support multiple images', () => {
    const imgs: ImageInput[] = [
      { base64: 'aaa', mediaType: 'image/png', source: 'a.png' },
      { base64: 'bbb', mediaType: 'image/jpeg', source: 'b.jpg' },
    ];
    const result = withImages('two images', imgs);
    expect(result.images).toHaveLength(2);
  });
});

describe('isWithImagesResult()', () => {
  it('should return true for withImages() output', () => {
    const result = withImages('test', [SAMPLE_IMAGE]);
    expect(isWithImagesResult(result)).toBe(true);
  });

  it('should return false for plain objects', () => {
    expect(isWithImagesResult({ text: 'nope' })).toBe(false);
    expect(isWithImagesResult({})).toBe(false);
    expect(isWithImagesResult(null)).toBe(false);
    expect(isWithImagesResult(undefined)).toBe(false);
    expect(isWithImagesResult('string')).toBe(false);
    expect(isWithImagesResult(42)).toBe(false);
    expect(isWithImagesResult([])).toBe(false);
  });

  it('should return false for manually constructed fake marker', () => {
    // Marker must be exactly true
    expect(isWithImagesResult({ __withImages: 'true', text: 'x', images: [] })).toBe(false);
    expect(isWithImagesResult({ __withImages: 1, text: 'x', images: [] })).toBe(false);
  });
});

// ============================================================
// 2. Context.addToolMessage() 图片透传
// ============================================================

describe('Context.addToolMessage() with images', () => {
  it('should propagate images to enriched messages', () => {
    const ctx = new Context();
    const call = makeToolCall('call_1', 'read_image');
    const result: ToolExecResult = {
      success: true,
      result: 'image loaded',
      images: [SAMPLE_IMAGE],
    };

    ctx.addToolMessage(call, result, 0);
    const all = ctx.getAll();

    expect(all).toHaveLength(1);
    expect(all[0].role).toBe('tool');
    expect(all[0].images).toBeDefined();
    expect(all[0].images).toHaveLength(1);
    expect(all[0].images![0].source).toBe('test.png');
  });

  it('should propagate images to messages array', () => {
    const ctx = new Context();
    const call = makeToolCall('call_1', 'read_image');
    const result: ToolExecResult = {
      success: true,
      result: 'image loaded',
      images: [SAMPLE_IMAGE],
    };

    ctx.addToolMessage(call, result, 0);
    const msgs = ctx.getAll();

    expect(msgs).toHaveLength(1);
    expect(msgs[0].images).toBeDefined();
    expect(msgs[0].images).toHaveLength(1);
  });

  it('should replay serialized tool content and images into both context views', () => {
    const ctx = new Context();
    const content = '{"success":true,"result":"already serialized"}';

    ctx.addSerializedToolMessage('call_replay', content, 3, [SAMPLE_IMAGE]);

    const messages = ctx.getAll();
    const enriched = ctx.getAllEnriched();
    expect(messages).toHaveLength(1);
    expect(enriched).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_replay',
      content,
      turn: 3,
      images: [SAMPLE_IMAGE],
    });
    expect(enriched[0]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_replay',
      content,
      turn: 3,
      images: [SAMPLE_IMAGE],
    });
  });

  it('should not set images when result has no images', () => {
    const ctx = new Context();
    const call = makeToolCall('call_1', 'bash');
    const result: ToolExecResult = {
      success: true,
      result: 'command output',
    };

    ctx.addToolMessage(call, result, 0);
    const all = ctx.getAll();

    expect(all[0].images).toBeUndefined();
  });

  it('should not set images when result.images is empty array', () => {
    const ctx = new Context();
    const call = makeToolCall('call_1', 'bash');
    const result: ToolExecResult = {
      success: true,
      result: 'command output',
      images: [],
    };

    ctx.addToolMessage(call, result, 0);
    const all = ctx.getAll();

    expect(all[0].images).toBeUndefined();
  });
});

// ============================================================
// 3. Anthropic 编译器：tool 消息图片
// ============================================================

describe('Anthropic compiler: tool message images', () => {
  const baseMessages = [
    { role: 'user' as const, content: 'read this image', turn: 0 },
    {
      role: 'assistant' as const,
      content: 'Let me read it.',
      turn: 0,
      toolCalls: [makeToolCall('call_1', 'read_image')],
    },
  ];

  it('should embed image blocks in tool_result.content (vision mode)', () => {
    const messages = [
      ...baseMessages,
      {
        role: 'tool' as const,
        content: JSON.stringify({ success: true, result: 'image loaded' }),
        turn: 0,
        toolCallId: 'call_1',
        images: [SAMPLE_IMAGE],
      },
    ];

    const compiled = compileContextForAnthropic(messages, TOOLS, true);

    // Find the user message containing tool_result blocks
    const userMsg = compiled.messages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content)
    );
    expect(userMsg).toBeDefined();

    const toolResultBlock = (userMsg!.content as any[]).find(
      (b: any) => b.type === 'tool_result'
    );
    expect(toolResultBlock).toBeDefined();
    expect(Array.isArray(toolResultBlock.content)).toBe(true);

    // Should have text block + image block
    const blocks = toolResultBlock.content as any[];
    const textBlock = blocks.find((b: any) => b.type === 'text');
    const imageBlock = blocks.find((b: any) => b.type === 'image');

    expect(textBlock).toBeDefined();
    expect(imageBlock).toBeDefined();
    expect(imageBlock.source.media_type).toBe('image/png');
    expect(imageBlock.source.data).toBe('iVBORw0KGgo=');
  });

  it('should degrade to text placeholders (non-vision mode)', () => {
    const messages = [
      ...baseMessages,
      {
        role: 'tool' as const,
        content: JSON.stringify({ success: true, result: 'image loaded' }),
        turn: 0,
        toolCallId: 'call_1',
        images: [SAMPLE_IMAGE],
      },
    ];

    const compiled = compileContextForAnthropic(messages, TOOLS, false);

    const userMsg = compiled.messages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content)
    );
    const toolResultBlock = (userMsg!.content as any[]).find(
      (b: any) => b.type === 'tool_result'
    );

    // content should be a string with placeholder
    expect(typeof toolResultBlock.content).toBe('string');
    expect(toolResultBlock.content).toContain('【Image】test.png');
  });

  it('should produce string content when tool has no images', () => {
    const messages = [
      ...baseMessages,
      {
        role: 'tool' as const,
        content: JSON.stringify({ success: true, result: 'done' }),
        turn: 0,
        toolCallId: 'call_1',
      },
    ];

    const compiled = compileContextForAnthropic(messages, TOOLS, true);
    const userMsg = compiled.messages.find(
      (m: any) => m.role === 'user' && Array.isArray(m.content)
    );
    const toolResultBlock = (userMsg!.content as any[]).find(
      (b: any) => b.type === 'tool_result'
    );

    expect(typeof toolResultBlock.content).toBe('string');
  });
});

// ============================================================
// 4. OpenAI Responses 编译器：tool 消息图片
// ============================================================

describe('OpenAI Responses compiler: tool message images', () => {
  const baseMessages = [
    { role: 'system' as const, content: 'You are an assistant.' },
    { role: 'user' as const, content: 'read this image' },
    {
      role: 'assistant' as const,
      content: 'Reading.',
      turn: 0,
      toolCalls: [makeToolCall('call_1', 'read_image')],
    },
  ];

  it('should append user message with input_image (vision mode)', () => {
    const messages = [
      ...baseMessages,
      {
        role: 'tool' as const,
        content: JSON.stringify({ success: true, result: 'image loaded' }),
        turn: 0,
        toolCallId: 'call_1',
        images: [SAMPLE_IMAGE],
      },
    ];

    const compiled = compileContextForOpenAIResponses(messages, TOOLS, {
      modelName: 'gpt-4o',
      visionEnabled: true,
    });

    // Should have: function_call_output + user message with image
    const outputIdx = compiled.input.findIndex(
      (item: any) => item.type === 'function_call_output'
    );
    expect(outputIdx).toBeGreaterThanOrEqual(0);

    // Next item should be a user message with image
    const nextItem = compiled.input[outputIdx + 1];
    expect(nextItem.type).toBe('message');
    expect(nextItem.role).toBe('user');

    const contentParts = nextItem.content;
    const imagePart = contentParts.find((p: any) => p.type === 'input_image');
    expect(imagePart).toBeDefined();
    expect(imagePart.image_url).toContain('data:image/png;base64,');
  });

  it('should append text placeholder user message (non-vision mode)', () => {
    const messages = [
      ...baseMessages,
      {
        role: 'tool' as const,
        content: JSON.stringify({ success: true, result: 'image loaded' }),
        turn: 0,
        toolCallId: 'call_1',
        images: [SAMPLE_IMAGE],
      },
    ];

    const compiled = compileContextForOpenAIResponses(messages, TOOLS, {
      modelName: 'gpt-4o',
      visionEnabled: false,
    });

    const outputIdx = compiled.input.findIndex(
      (item: any) => item.type === 'function_call_output'
    );
    const nextItem = compiled.input[outputIdx + 1];

    expect(nextItem.type).toBe('message');
    expect(nextItem.role).toBe('user');

    const textPart = nextItem.content[0];
    expect(textPart.type).toBe('input_text');
    expect(textPart.text).toContain('【Image】test.png');
  });

  it('should not append extra user message when tool has no images', () => {
    const messages = [
      ...baseMessages,
      {
        role: 'tool' as const,
        content: JSON.stringify({ success: true, result: 'done' }),
        turn: 0,
        toolCallId: 'call_1',
      },
    ];

    const compiled = compileContextForOpenAIResponses(messages, TOOLS, {
      modelName: 'gpt-4o',
      visionEnabled: true,
    });

    const outputIdx = compiled.input.findIndex(
      (item: any) => item.type === 'function_call_output'
    );
    // Next item should NOT be a user message (or should be undefined if last)
    const nextItem = compiled.input[outputIdx + 1];
    if (nextItem) {
      expect(nextItem.type).not.toBe('message');
      expect(nextItem.role).not.toBe('user');
    }
  });
});
