import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Agent } from '../core/agent.js';
import { MemoryFeature } from '../features/memory/index.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';

class MemoryRollbackLLM implements LLMClient {
  async chat(messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    const lastUser = [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
    const systemMessages = messages.filter(message => message.role === 'system');
    const hasClaudeMemory = systemMessages.some(message => message.content.includes('memory-from-claude-md'));

    if (lastUser === 'first') {
      return { content: hasClaudeMemory ? 'first-with-memory' : 'first-without-memory' };
    }

    if (lastUser === 'first edited') {
      return { content: hasClaudeMemory ? 'edited-with-memory' : 'edited-without-memory' };
    }

    return { content: hasClaudeMemory ? 'with-memory' : 'without-memory' };
  }
}

class MemoryRollbackAgent extends Agent {
  constructor() {
    super({
      llm: new MemoryRollbackLLM(),
      maxTurns: 2,
      name: 'MemoryRollbackAgent',
      systemMessage: 'memory rollback test',
    });
    this.use(new MemoryFeature());
  }
}

describe('Memory rollback first-call', () => {
  it('should re-inject CLAUDE.md memory after rollback to first call', async () => {
    const previousCwd = process.cwd();
    const projectDir = await mkdtemp(join(tmpdir(), 'agentdev-memory-rollback-'));

    try {
      await mkdir(join(projectDir, '.agentdev'), { recursive: true });
      await writeFile(join(projectDir, 'CLAUDE.md'), '# Project Memory\nmemory-from-claude-md\n', 'utf-8');
      process.chdir(projectDir);

      const agent = new MemoryRollbackAgent();
      const first = await agent.onCall('first');
      expect(first).toBe('first-with-memory');

      const rollback = await agent.rollbackToCall(0);
      expect(rollback.draftInput).toBe('first');
      expect(agent.getContext().getAll().filter(message => message.role === 'user')).toHaveLength(0);

      const resumed = await agent.onCall('first edited');
      expect(resumed).toBe('edited-with-memory');
    } finally {
      process.chdir(previousCwd);
    }
  });
});
