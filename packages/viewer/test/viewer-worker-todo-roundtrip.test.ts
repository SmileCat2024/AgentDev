import { describe, it, expect } from 'vitest';
import { ViewerWorker } from '../src/viewer-worker.js';
import type { TodoPlanSnapshot } from '@agentdev/core';

/**
 * Round-trip 测试：验证 todo plan 数据经过 ViewerWorker 的
 * write (handleUpdateTodoPlan → normalizeTodoPlan) → read (handleGetAgentTodoPlan)
 * 管线后，所有字段完整保留。
 *
 * 背景：interruptTargetId 字段曾因 normalizeTodoPlan 手动重建对象时遗漏而被
 * 静默丢弃，导致前端断点显示几秒后消失（业务逻辑正常）。
 * 此测试确保类似字段不会再被吞掉。
 */

function getTestUdsPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdev-todo-roundtrip-${process.pid}-${Date.now()}`;
  }
  return `/tmp/agentdev-todo-roundtrip-${process.pid}-${Date.now()}.sock`;
}

/** 模拟 HTTP response，捕获 writeHead 状态码与 end 返回体 */
function createMockRes() {
  let statusCode = 0;
  let body = '';
  return {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { body = data; },
    getStatusCode() { return statusCode; },
    getBody() { return body; },
    getJson() { return JSON.parse(body); },
  };
}

/** 构造一个含全部字段（含扩展字段）的 todo plan */
function buildFullPlan(): TodoPlanSnapshot {
  return {
    feature: 'todo',
    updatedAt: 1700000000000,
    counter: 3,
    tasks: [
      {
        id: 'task-1',
        subject: '已完成任务',
        description: 'desc-1',
        status: 'completed',
        metadata: { finishedAt: 1700000001000 },
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
      },
      {
        id: 'task-2',
        subject: '进行中任务',
        description: 'desc-2',
        status: 'in_progress',
        metadata: {},
        createdAt: 1700000002000,
        updatedAt: 1700000002000,
      },
    ],
    summary: {
      total: 2,
      pending: 0,
      inProgress: 1,
      completed: 1,
      cancelled: 0,
    },
    interruptTargetId: 'task-2',
  };
}

describe('ViewerWorker todo plan round-trip', () => {
  it('preserves interruptTargetId through write → read round-trip', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'roundtrip-interrupt-agent';
    worker.getOrCreateSession(agentId, 'Interrupt RoundTrip');

    const inputPlan = buildFullPlan();
    worker.handleUpdateTodoPlan({ agentId, plan: inputPlan });

    const res = createMockRes();
    worker.handleGetAgentTodoPlan({} as any, res as any, agentId);

    expect(res.getStatusCode()).toBe(200);
    const output = res.getJson();
    // 这正是之前被 normalizeTodoPlan 丢弃的字段
    expect(output.interruptTargetId).toBe('task-2');
  });

  it('preserves all standard todo plan fields through round-trip', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'roundtrip-full-agent';
    worker.getOrCreateSession(agentId, 'Full RoundTrip');

    const inputPlan = buildFullPlan();
    worker.handleUpdateTodoPlan({ agentId, plan: inputPlan });

    const res = createMockRes();
    worker.handleGetAgentTodoPlan({} as any, res as any, agentId);

    const output = res.getJson();
    expect(output.feature).toBe('todo');
    expect(output.counter).toBe(3);
    expect(output.tasks).toHaveLength(2);
    expect(output.tasks[0].id).toBe('task-1');
    expect(output.tasks[0].status).toBe('completed');
    expect(output.tasks[0].metadata.finishedAt).toBe(1700000001000);
    expect(output.tasks[1].id).toBe('task-2');
    expect(output.tasks[1].status).toBe('in_progress');
    expect(output.summary.total).toBe(2);
    expect(output.summary.inProgress).toBe(1);
  });

  it('strips old schema fields (activeForm/owner/blocks/blockedBy) during normalize', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'roundtrip-strip-agent';
    worker.getOrCreateSession(agentId, 'Strip Old Fields');

    // Feed a plan with old fields that should be stripped
    const oldPlan = {
      feature: 'todo' as const,
      updatedAt: 1700000000000,
      counter: 1,
      tasks: [{
        id: 'task-old',
        subject: 'Old task',
        description: 'desc',
        activeForm: 'Doing old task',
        status: 'pending',
        owner: 'agent-A',
        blocks: ['task-2'],
        blockedBy: ['task-3'],
        metadata: {},
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      }],
      summary: { total: 1, pending: 1, inProgress: 0, completed: 0, cancelled: 0 },
      interruptTargetId: null,
    };

    worker.handleUpdateTodoPlan({ agentId, plan: oldPlan as any });

    const res = createMockRes();
    worker.handleGetAgentTodoPlan({} as any, res as any, agentId);

    const output = res.getJson();
    const task = output.tasks[0];
    expect(task.id).toBe('task-old');
    expect(task.subject).toBe('Old task');
    // Old fields should be stripped
    expect(task).not.toHaveProperty('activeForm');
    expect(task).not.toHaveProperty('owner');
    expect(task).not.toHaveProperty('blocks');
    expect(task).not.toHaveProperty('blockedBy');
  });

  it('returns null interruptTargetId when not set', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'roundtrip-null-agent';
    worker.getOrCreateSession(agentId, 'Null Interrupt');

    const plan = buildFullPlan();
    delete (plan as any).interruptTargetId;
    worker.handleUpdateTodoPlan({ agentId, plan });

    const res = createMockRes();
    worker.handleGetAgentTodoPlan({} as any, res as any, agentId);

    const output = res.getJson();
    expect(output.interruptTargetId).toBeNull();
  });

  it('returns empty plan with null interruptTargetId for new session', () => {
    const worker = new ViewerWorker(0, false, getTestUdsPath());
    const agentId = 'roundtrip-empty-agent';
    worker.getOrCreateSession(agentId, 'Empty Session');

    // 未写入任何 todo plan，直接读取
    const res = createMockRes();
    worker.handleGetAgentTodoPlan({} as any, res as any, agentId);

    const output = res.getJson();
    expect(output.interruptTargetId).toBeNull();
    expect(output.tasks).toEqual([]);
  });
});
