/**
 * TodoFeature onCallStart bg 唤醒跳过（ADR-0019 阶段 1）
 *
 * bg reminder 唤醒的 call（user-turn metadata 带 shell 命名空间）不注入
 * "请继续推进任务计划" 简报：后台汇报自带全部信息，不该被催促。
 */

import { describe, it, expect } from 'vitest';
import { TodoFeature } from '../index.js';
import { Context } from '../../../core/context.js';
import type { CallStartContext } from '../../../core/lifecycle.js';

function makeCtx(overrides: Partial<CallStartContext> = {}): CallStartContext {
  return {
    input: '[后台任务 bg-1 运行中]',
    isFirstCall: false,
    context: new Context(),
    ...overrides,
  } as CallStartContext;
}

describe('TodoFeature onCallStart：bg 唤醒跳过简报注入', () => {
  it('metadata.shell 存在时不注入 brief（唤醒的 call 不被催促）', async () => {
    const feature = new TodoFeature();
    feature.createTask('任务A', '完成构建');

    const ctx = makeCtx({ metadata: { shell: { taskId: 'bg-1' } } });
    await feature.onCallStart(ctx);

    expect(ctx.context.getAll()).toHaveLength(0);
  });

  it('无 metadata 时照常注入简报', async () => {
    const feature = new TodoFeature();
    feature.createTask('任务A', '完成构建');

    const ctx = makeCtx();
    await feature.onCallStart(ctx);

    const messages = ctx.context.getAll();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('system');
  });

  it('metadata 不含 shell 命名空间时照常注入（其他来源 metadata 不受影响）', async () => {
    const feature = new TodoFeature();
    feature.createTask('任务A', '完成构建');

    const ctx = makeCtx({ metadata: { dispatch: { threadId: 't-1' } } });
    await feature.onCallStart(ctx);

    expect(ctx.context.getAll()).toHaveLength(1);
  });
});
