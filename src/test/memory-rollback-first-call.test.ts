import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Agent } from '../core/agent.js';
import { MemoryFeature } from '../features/memory/index.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../core/types.js';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

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

async function testMemoryReinjectsAfterRollbackToFirstCall(): Promise<void> {
  const previousCwd = process.cwd();
  const projectDir = await mkdtemp(join(tmpdir(), 'agentdev-memory-rollback-'));

  try {
    await mkdir(join(projectDir, '.agentdev'), { recursive: true });
    await writeFile(join(projectDir, 'CLAUDE.md'), '# Project Memory\nmemory-from-claude-md\n', 'utf-8');
    process.chdir(projectDir);

    const agent = new MemoryRollbackAgent();
    const first = await agent.onCall('first');
    assert(first === 'first-with-memory', 'first call should include CLAUDE.md memory');

    const rollback = await agent.rollbackToCall(0);
    assert(rollback.draftInput === 'first', 'rollback should return the original first input');
    assert(agent.getContext().getAll().filter(message => message.role === 'user').length === 0, 'rollback to first call should clear user history');

    const resumed = await agent.onCall('first edited');
    assert(resumed === 'edited-with-memory', 'edited first call after rollback should re-inject CLAUDE.md memory');
  } finally {
    process.chdir(previousCwd);
  }
}

await testMemoryReinjectsAfterRollbackToFirstCall();
console.log('Memory rollback first-call tests passed');
