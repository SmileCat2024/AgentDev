/**
 * 预置 Agent 纯基类断言（ticket 009：BasicAgent / ExplorerAgent 零内置装配）
 *
 * 1. import 面：BasicAgent / ExplorerAgent 源码不 import 任何 feature 模块
 *    （ADR-0003 core 纪律：agents 域零 feature 反向依赖）
 * 2. 运行时：构造后零 feature 注册、零工具、零可创建子代理类型——
 *    文件工具 / skills / MCP / 子代理一律由宿主显式 use() 挂载
 */
import { test, expect } from 'vitest';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { BasicAgent } from '../src/agents/index.js';
import { ExplorerAgent } from '../src/agents/system/ExplorerAgent.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';

class MockLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'ok' };
  }
}

const here = dirname(fileURLToPath(import.meta.url));

test('BasicAgent / ExplorerAgent 源码 import 面不含 feature 模块', async () => {
  for (const file of ['../src/agents/system/BasicAgent.ts', '../src/agents/system/ExplorerAgent.ts']) {
    const source = await readFile(join(here, file), 'utf8');
    const importPaths = [...source.matchAll(/^import\s+(?:type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]/gm)]
      .map(match => match[1]);
    expect(importPaths.length, `${file} 应能解析出 import 语句`).toBeGreaterThan(0);
    for (const importPath of importPaths) {
      expect(importPath, `${file} 不应 import feature 模块: ${importPath}`).not.toContain('features/');
    }
  }
});

test('BasicAgent 构造后零 feature 注册', () => {
  const agent = new BasicAgent({ llm: new MockLLM(), name: 'pure-base-basic' });

  expect((agent as any).features.size).toBe(0);
  expect(agent.getTools().getAll()).toHaveLength(0);
  expect(agent.getRegisteredAgentTypes()).toHaveLength(0);
});

test('ExplorerAgent 构造后零 feature 注册', () => {
  const agent = new ExplorerAgent({ llm: new MockLLM(), name: 'pure-base-explorer' });

  expect((agent as any).features.size).toBe(0);
  expect(agent.getTools().getAll()).toHaveLength(0);
  expect(agent.getRegisteredAgentTypes()).toHaveLength(0);
});

test('宿主显式装配路径仍然可用（use() 挂载自定义 Feature）', async () => {
  const feature = {
    name: 'host-assembly-probe',
    getTools: () => [{
      name: 'host_probe_tool',
      description: 'host-assembled tool',
      parameters: { type: 'object' as const, properties: {} },
      execute: async () => 'ok',
    }],
  };
  const agent = new BasicAgent({ llm: new MockLLM(), name: 'pure-base-host-assembly' });
  agent.use(feature as any);

  // 工具注册发生在 ensureFeatureTools（首次 onCall 前置阶段），不在 use() 时
  await agent.ensureFeatureTools();

  expect((agent as any).features.size).toBe(1);
  expect(agent.getTools().getAll().map(tool => tool.name)).toContain('host_probe_tool');
});
