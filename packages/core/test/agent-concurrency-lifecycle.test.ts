import { describe, it, expect } from 'vitest';
import { Agent } from '../src/core/agent.js';
import type { AgentFeature, FeatureInitContext } from '../src/core/feature.js';
import type { LLMClient, LLMResponse, Message, Tool } from '../src/core/types.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

class ImmediateLLM implements LLMClient {
  async chat(_messages: Message[], _tools: Tool[]): Promise<LLMResponse> {
    return { content: 'done' };
  }
}

describe('Agent call and lifecycle concurrency', () => {
  it('serializes concurrent calls for one Agent instance', async () => {
    const firstResponse = deferred<LLMResponse>();
    const startedInputs: string[] = [];
    let callCount = 0;
    const llm: LLMClient = {
      async chat(messages) {
        const input = [...messages].reverse().find(message => message.role === 'user')?.content;
        startedInputs.push(String(input));
        callCount++;
        if (callCount === 1) return firstResponse.promise;
        return { content: 'second done' };
      },
    };
    const agent = new Agent({ llm, maxTurns: 1 });

    const first = agent.onCall('first');
    await waitFor(() => startedInputs.length === 1);
    const second = agent.onCall('second');

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(startedInputs).toEqual(['first']);
    expect(agent.isRunning()).toBe(true);

    firstResponse.resolve({ content: 'first done' });
    await Promise.all([first, second]);

    expect(startedInputs).toEqual(['first', 'second']);
    expect(agent.getContext().getAll().filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['first', 'second']);
  });

  it('shares one in-flight Feature initialization across concurrent callers', async () => {
    const gate = deferred<void>();
    class CountingFeature implements AgentFeature {
      readonly name = 'counting';
      initiated = 0;

      async onInitiate(_ctx: FeatureInitContext): Promise<void> {
        this.initiated++;
        await gate.promise;
      }
    }

    const feature = new CountingFeature();
    const agent = new Agent({ llm: new ImmediateLLM() }).use(feature);
    const first = agent.createSessionSnapshot('first');
    await waitFor(() => feature.initiated === 1);
    const second = agent.createSessionSnapshot('second');

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(feature.initiated).toBe(1);

    gate.resolve();
    await Promise.all([first, second]);
    expect(feature.initiated).toBe(1);
  });

  it('waits for an active call before destroying Features and rejects queued calls', async () => {
    const llmStarted = deferred<void>();
    const releaseLlm = deferred<LLMResponse>();
    const llm: LLMClient = {
      async chat(_messages, _tools, options) {
        llmStarted.resolve();
        options?.signal?.addEventListener('abort', () => {
          releaseLlm.resolve({ content: 'interrupted' });
        }, { once: true });
        return releaseLlm.promise;
      },
    };
    class ResourceFeature implements AgentFeature {
      readonly name = 'resource';
      destroyed = 0;
      async onDestroy(): Promise<void> {
        this.destroyed++;
      }
    }

    const feature = new ResourceFeature();
    const agent = new Agent({ llm, maxTurns: 1 }).use(feature);
    const activeCall = agent.onCall('active');
    await llmStarted.promise;
    const queuedCall = agent.onCall('queued');

    await agent.dispose();

    expect(feature.destroyed).toBe(1);
    expect(agent.isRunning()).toBe(false);
    await expect(activeCall).resolves.toBe('interrupted');
    await expect(queuedCall).rejects.toThrow('Agent is disposing or has been disposed');
    await expect(agent.onCall('after dispose')).rejects.toThrow('Agent is disposing or has been disposed');
  });
});
