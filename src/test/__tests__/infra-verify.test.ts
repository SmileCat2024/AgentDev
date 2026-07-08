/**
 * Vitest 基础设施验证测试
 *
 * 验证项：
 * 1. vitest 能正确导入项目源码
 * 2. describe / it / expect 正常工作
 * 3. 异步测试正常工作
 */

import { describe, it, expect } from 'vitest';
import { createMessage, system, user, assistant, toolResult, cloneMessages } from '../../core/message.js';
import { PlaceholderResolver } from '../../template/resolver.js';
import { ToolRegistry } from '../../core/tool.js';

describe('vitest infrastructure: message factories', () => {
  it('should create a system message', () => {
    const msg = system('hello');
    expect(msg.role).toBe('system');
    expect(msg.content).toBe('hello');
  });

  it('should create a user message', () => {
    const msg = user('question');
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('question');
  });

  it('should create an assistant message with tool calls', () => {
    const msg = assistant('thinking', [{ id: 'tc_1', name: 'search', arguments: { q: 'test' } }]);
    expect(msg.role).toBe('assistant');
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls![0].name).toBe('search');
  });

  it('should create a tool result message', () => {
    const msg = toolResult('tc_1', 'result text');
    expect(msg.role).toBe('tool');
    expect(msg.toolCallId).toBe('tc_1');
  });

  it('should clone messages without sharing references', () => {
    const original = [user('a'), user('b')];
    const cloned = cloneMessages(original);
    expect(cloned).not.toBe(original);
    expect(cloned).toHaveLength(2);
    expect(cloned[0]).not.toBe(original[0]);
    expect(cloned[0].content).toBe('a');
  });
});

describe('vitest infrastructure: PlaceholderResolver', () => {
  it('should resolve simple variables', () => {
    const result = PlaceholderResolver.resolve('Hello {{name}}!', { name: 'World' });
    expect(result).toBe('Hello World!');
  });

  it('should resolve nested paths', () => {
    const result = PlaceholderResolver.resolve('{{user.name}}', { user: { name: 'Alice' } });
    expect(result).toBe('Alice');
  });

  it('should use default value when variable is missing', () => {
    const result = PlaceholderResolver.resolve('{{missing|default}}', {});
    expect(result).toBe('default');
  });

  it('should process each loops', () => {
    const result = PlaceholderResolver.resolve(
      '{{#each}}items\n  - {{name}}\n{{/each}}',
      { items: [{ name: 'a' }, { name: 'b' }] },
    );
    expect(result).toContain('a');
    expect(result).toContain('b');
  });
});

describe('vitest infrastructure: ToolRegistry', () => {
  it('should register and retrieve tools', () => {
    const registry = new ToolRegistry();
    const tool = {
      name: 'test_tool',
      description: 'A test tool',
      execute: async () => 'ok',
    };
    registry.register(tool);
    const all = registry.getAll();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('test_tool');
  });

  it('should enable/disable tools', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'my_tool',
      description: 'test',
      execute: async () => {},
    });
    expect(registry.isEnabled('my_tool')).toBe(true);

    registry.disable('my_tool');
    expect(registry.isEnabled('my_tool')).toBe(false);
  });
});

describe('vitest infrastructure: async support', () => {
  it('should handle async operations', async () => {
    const value = await Promise.resolve(42);
    expect(value).toBe(42);
  });
});
