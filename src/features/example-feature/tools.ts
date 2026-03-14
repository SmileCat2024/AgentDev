import { createTool } from '../../core/tool.js';
import type { Tool } from '../../core/types.js';
import type { ExampleFeatureRuntimeState, ExampleFeatureToolResult } from './types.js';

export function createExampleTool(deps: {
  getState(): ExampleFeatureRuntimeState;
  incrementCounter(): void;
  addNote(note: string): void;
}): Tool {
  return createTool({
    name: 'example_tool',
    description: '示范工具：展示 Feature 内部状态、模板渲染和上下文注入是如何连起来的。',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: '要记录的一条示意说明',
        },
      },
      required: [],
    },
    render: {
      call: 'example-tool',
      result: 'example-tool',
    },
    execute: async ({ note }, context) => {
      // 这里故意保留一个最常见的 Feature 工具结构：
      // 1. 读取注入的运行时上下文
      // 2. 更新 Feature 状态
      // 3. 返回纯对象，交给模板渲染
      const injected = (context as { _exampleFeature?: { enabled: boolean; counter: number } } | undefined)?._exampleFeature;

      deps.incrementCounter();
      if (typeof note === 'string' && note.trim()) {
        deps.addNote(note.trim());
      }

      const result: ExampleFeatureToolResult = {
        enabled: deps.getState().enabled,
        counter: deps.getState().counter,
        lastInput: deps.getState().lastInput,
        notes: deps.getState().notes,
        injected,
      };
      return result;
    },
  });
}
