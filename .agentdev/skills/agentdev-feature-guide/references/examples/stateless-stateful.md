# 范例：无状态工具与可恢复状态

## 无状态转换 Feature

```ts
import { createTool, type AgentFeature, type Tool } from 'agentdev';

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('text 必须是字符串');
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text) throw new Error('text 不能为空');
  if (text.length > 2_000) throw new Error('text 不能超过 2000 字符');
  return text;
}

export class TextFeature implements AgentFeature {
  readonly name = 'text';
  readonly description = '提供确定性的短文本规范化能力。';

  getTools(): Tool[] {
    return [createTool({
      name: 'text_normalize',
      description: [
        '规范化短文本中的首尾空白和连续空格。',
        '只处理纯文本，不用于代码或需要保留排版的内容。',
        '返回规范化文本和字符数。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '不超过 2000 字符的纯文本。' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      parallelizable: true,
      execute: async ({ text }) => {
        const normalized = normalizeText(text);
        return { ok: true, text: normalized, length: normalized.length };
      },
    })];
  }
}
```

该 Feature 不需要初始化、清理、hooks、配置或快照。纯工具仍要具备明确边界、运行时校验和有界结果。

## 可恢复队列 Feature

```ts
import {
  createTool,
  type AgentFeature,
  type FeatureStateSnapshot,
  type Tool,
} from 'agentdev';

interface QueueItem {
  id: string;
  text: string;
  status: 'pending' | 'done';
}

interface QueueSnapshot {
  schemaVersion: 1;
  nextId: number;
  items: QueueItem[];
}

function parseSnapshot(raw: unknown): QueueSnapshot {
  if (!raw || typeof raw !== 'object') {
    return { schemaVersion: 1, nextId: 1, items: [] };
  }
  const value = raw as Record<string, unknown>;
  const items = Array.isArray(value.items)
    ? value.items.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const entry = item as Record<string, unknown>;
        if (typeof entry.id !== 'string' || typeof entry.text !== 'string') return [];
        if (entry.status !== 'pending' && entry.status !== 'done') return [];
        return [{ id: entry.id, text: entry.text, status: entry.status } as QueueItem];
      })
    : [];
  return {
    schemaVersion: 1,
    nextId: Number.isInteger(value.nextId) && Number(value.nextId) > 0
      ? Number(value.nextId)
      : 1,
    items,
  };
}

export class QueueFeature implements AgentFeature {
  readonly name = 'queue';
  readonly description = '维护当前会话中可回滚、可恢复的工作队列。';

  private nextId = 1;
  private items: QueueItem[] = [];

  list(): ReadonlyArray<QueueItem> {
    return this.items.map(item => ({ ...item }));
  }

  private add(text: string): QueueItem {
    const normalized = text.trim();
    if (!normalized) throw new Error('text 不能为空');
    const item: QueueItem = {
      id: `q-${this.nextId++}`,
      text: normalized,
      status: 'pending',
    };
    this.items.push(item);
    return { ...item };
  }

  private complete(id: string): QueueItem | undefined {
    const item = this.items.find(candidate => candidate.id === id);
    if (!item) return undefined;
    item.status = 'done';
    return { ...item };
  }

  getTools(): Tool[] {
    return [
      createTool({
        name: 'queue_add',
        description: '向当前会话队列添加一项，返回稳定 ID。',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: '队列项正文。' } },
          required: ['text'],
          additionalProperties: false,
        },
        execute: async ({ text }) => ({ ok: true, item: this.add(String(text)) }),
      }),
      createTool({
        name: 'queue_list',
        description: '列出当前队列。该操作只读，可与其他只读操作并发。',
        parallelizable: true,
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => ({ ok: true, items: this.list() }),
      }),
      createTool({
        name: 'queue_complete',
        description: '将指定队列项标记为完成；ID 不存在时不修改状态。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'queue_list 返回的 ID。' } },
          required: ['id'],
          additionalProperties: false,
        },
        execute: async ({ id }) => {
          const item = this.complete(String(id));
          return item
            ? { ok: true, item }
            : { ok: false, code: 'not_found', error: `队列项 ${id} 不存在` };
        },
      }),
    ];
  }

  captureState(): FeatureStateSnapshot {
    return {
      schemaVersion: 1,
      nextId: this.nextId,
      items: this.items.map(item => ({ ...item })),
    } satisfies QueueSnapshot;
  }

  restoreState(raw: FeatureStateSnapshot): void {
    const state = parseSnapshot(raw);
    this.nextId = state.nextId;
    this.items = state.items.map(item => ({ ...item }));
  }
}
```

验收：工具集合确定；只读工具并发；写工具串行；公开 API 返回副本；快照往返、值拷贝和幂等恢复通过。
