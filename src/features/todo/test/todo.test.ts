import { describe, it, expect, beforeEach } from 'vitest';
import { TodoFeature } from '../index.js';
import type { TodoTask } from '../types.js';

describe('TodoFeature', () => {
  let feature: TodoFeature;

  beforeEach(() => {
    feature = new TodoFeature();
  });

  // ========== 初始化 ==========

  describe('initialization', () => {
    it('should have correct name and description', () => {
      expect(feature.name).toBe('todo');
      expect(feature.description).toContain('任务清单');
    });

    it('should start with empty tasks', () => {
      const snapshot = feature.captureState() as { tasks: TodoTask[]; counter: number };
      expect(snapshot.tasks).toHaveLength(0);
      expect(snapshot.counter).toBe(0);
    });

    it('should accept config for reminder thresholds', () => {
      const f = new TodoFeature({
        reminderThresholdWithTasks: 5,
        reminderThresholdWithoutTasks: 10,
      });
      expect(f).toBeDefined();
    });
  });

  // ========== 工具注册 ==========

  describe('getTools()', () => {
    it('should return 4 tools', () => {
      const tools = feature.getTools();
      expect(tools).toHaveLength(4);
    });

    it('should register tools with correct names', () => {
      const tools = feature.getTools();
      const names = tools.map(t => t.name);
      expect(names).toContain('task_create');
      expect(names).toContain('task_list');
      expect(names).toContain('task_update');
      expect(names).toContain('task_clear');
      // task_get should no longer exist
      expect(names).not.toContain('task_get');
    });
  });

  // ========== 任务 CRUD ==========

  describe('createTask()', () => {
    it('should create a task with pending status', () => {
      const task = feature.createTask('Fix bug', 'Fix the login bug');
      expect(task.id).toBe('1');
      expect(task.subject).toBe('Fix bug');
      expect(task.description).toBe('Fix the login bug');
      expect(task.status).toBe('pending');
    });

    it('should create a task without description', () => {
      const task = feature.createTask('Simple task');
      expect(task.subject).toBe('Simple task');
      expect(task.description).toBeUndefined();
      expect(task.status).toBe('pending');
    });

    it('should increment counter for each task', () => {
      const t1 = feature.createTask('Task 1');
      const t2 = feature.createTask('Task 2');
      const t3 = feature.createTask('Task 3');
      expect(t1.id).toBe('1');
      expect(t2.id).toBe('2');
      expect(t3.id).toBe('3');
    });

    it('should support metadata', () => {
      const task = feature.createTask('Task', 'Desc', {
        metadata: { priority: 'high' },
      });
      expect(task.metadata).toEqual({ priority: 'high' });
    });
  });

  describe('getTask()', () => {
    it('should return task by id', () => {
      feature.createTask('Task 1', 'Desc 1');
      const task = feature.getTask('1');
      expect(task).toBeDefined();
      expect(task!.subject).toBe('Task 1');
    });

    it('should return undefined for non-existent task', () => {
      const task = feature.getTask('999');
      expect(task).toBeUndefined();
    });
  });

  describe('listTasks()', () => {
    beforeEach(() => {
      feature.createTask('Task A', 'Desc A');
      feature.createTask('Task B', 'Desc B');
    });

    it('should list all task summaries', () => {
      const tasks = feature.listTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].id).toBe('1');
      expect(tasks[1].id).toBe('2');
    });

    it('should filter by status', () => {
      feature.updateTask('1', { status: 'completed' });
      const completed = feature.listTasks({ status: 'completed' });
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe('1');
    });

    it('should return summaries with correct fields', () => {
      const tasks = feature.listTasks();
      expect(tasks[0]).toHaveProperty('id');
      expect(tasks[0]).toHaveProperty('subject');
      expect(tasks[0]).toHaveProperty('status');
      // should NOT have old fields
      expect(tasks[0]).not.toHaveProperty('blockedBy');
      expect(tasks[0]).not.toHaveProperty('owner');
    });
  });

  describe('updateTask()', () => {
    it('should update task status', () => {
      feature.createTask('Task', 'Desc');
      const updated = feature.updateTask('1', { status: 'in_progress' });
      expect(updated!.status).toBe('in_progress');
    });

    it('should update subject and description', () => {
      feature.createTask('Old', 'Old desc');
      const updated = feature.updateTask('1', { subject: 'New', description: 'New desc' });
      expect(updated!.subject).toBe('New');
      expect(updated!.description).toBe('New desc');
    });

    it('should return undefined for non-existent task', () => {
      const updated = feature.updateTask('999', { status: 'completed' });
      expect(updated).toBeUndefined();
    });
  });

  describe('clearTasks()', () => {
    it('should mark pending tasks as deleted', () => {
      feature.createTask('Task 1', 'Desc 1');
      feature.createTask('Task 2', 'Desc 2');
      const count = feature.clearTasks();
      expect(count).toBe(2);
      expect(feature.getTask('1')!.status).toBe('deleted');
      expect(feature.getTask('2')!.status).toBe('deleted');
    });

    it('should mark in_progress tasks as deleted', () => {
      feature.createTask('Task 1', 'Desc 1');
      feature.updateTask('1', { status: 'in_progress' });
      feature.clearTasks();
      expect(feature.getTask('1')!.status).toBe('deleted');
    });

    it('should preserve completed tasks', () => {
      feature.createTask('Task 1', 'Desc 1');
      feature.updateTask('1', { status: 'completed' });
      feature.clearTasks();
      expect(feature.getTask('1')!.status).toBe('completed');
    });

    it('should return cancelled count', () => {
      feature.createTask('Task 1');
      feature.createTask('Task 2');
      feature.updateTask('2', { status: 'completed' });
      feature.createTask('Task 3');
      const count = feature.clearTasks();
      // Only #1 (pending) and #3 (pending) should be cancelled; #2 (completed) preserved
      expect(count).toBe(2);
    });
  });

  // ========== 状态转换 ==========

  describe('state transitions', () => {
    it('should support pending → in_progress → completed', () => {
      feature.createTask('Task', 'Desc');
      expect(feature.getTask('1')!.status).toBe('pending');

      feature.updateTask('1', { status: 'in_progress' });
      expect(feature.getTask('1')!.status).toBe('in_progress');

      feature.updateTask('1', { status: 'completed' });
      expect(feature.getTask('1')!.status).toBe('completed');
    });

    it('should support deletion via status update', () => {
      feature.createTask('Task', 'Desc');
      feature.updateTask('1', { status: 'deleted' });
      expect(feature.getTask('1')!.status).toBe('deleted');
    });
  });

  // ========== captureState / restoreState ==========

  describe('captureState() / restoreState()', () => {
    it('should capture tasks and counter', () => {
      feature.createTask('Task 1', 'Desc 1');
      feature.createTask('Task 2', 'Desc 2');
      const snapshot = feature.captureState() as { tasks: TodoTask[]; counter: number };

      expect(snapshot.counter).toBe(2);
      expect(snapshot.tasks).toHaveLength(2);
    });

    it('should restore tasks and counter', () => {
      feature.createTask('Task 1', 'Desc 1');
      const snapshot = feature.captureState();

      const fresh = new TodoFeature();
      fresh.restoreState(snapshot);

      expect(fresh.getTask('1')).toBeDefined();
      expect(fresh.getTask('1')!.subject).toBe('Task 1');
    });

    it('should restore counter correctly', () => {
      feature.createTask('A');
      feature.createTask('B');
      feature.createTask('C');
      const snapshot = feature.captureState();

      const fresh = new TodoFeature();
      fresh.restoreState(snapshot);

      // Next task should be id=4
      const t4 = fresh.createTask('D');
      expect(t4.id).toBe('4');
    });

    it('should strip old schema fields on restore (white-list)', () => {
      // Simulate old session data with removed fields
      const oldSnapshot = {
        tasks: [{
          id: '1',
          subject: 'Old task',
          description: 'Old desc',
          status: 'pending' as const,
          activeForm: 'Doing old task',
          owner: 'agent_1',
          blocks: ['2'],
          blockedBy: ['3'],
          metadata: {},
          createdAt: 100,
          updatedAt: 200,
        }],
        counter: 1,
      };

      const fresh = new TodoFeature();
      fresh.restoreState(oldSnapshot as any);

      const task = fresh.getTask('1')!;
      expect(task.subject).toBe('Old task');
      expect(task.status).toBe('pending');
      // Old fields should be stripped
      expect((task as any).activeForm).toBeUndefined();
      expect((task as any).owner).toBeUndefined();
      expect((task as any).blocks).toBeUndefined();
      expect((task as any).blockedBy).toBeUndefined();
    });
  });

  // ========== getPlanSnapshot ==========

  describe('getPlanSnapshot()', () => {
    it('should return correct summary counts', () => {
      feature.createTask('A');
      feature.createTask('B');
      feature.createTask('C');
      feature.updateTask('1', { status: 'in_progress' });
      feature.updateTask('2', { status: 'completed' });
      feature.updateTask('3', { status: 'deleted' });

      const snapshot = feature.getPlanSnapshot();
      expect(snapshot.summary.total).toBe(3);
      expect(snapshot.summary.pending).toBe(0);
      expect(snapshot.summary.inProgress).toBe(1);
      expect(snapshot.summary.completed).toBe(1);
      expect(snapshot.summary.cancelled).toBe(1);
    });

    it('should NOT have blocked field in summary', () => {
      const snapshot = feature.getPlanSnapshot();
      expect(snapshot.summary).not.toHaveProperty('blocked');
    });

    it('should NOT have blocks/blockedBy/owner/activeForm in tasks', () => {
      feature.createTask('A');
      const snapshot = feature.getPlanSnapshot();
      const task = snapshot.tasks[0];
      expect(task).not.toHaveProperty('blocks');
      expect(task).not.toHaveProperty('blockedBy');
      expect(task).not.toHaveProperty('owner');
      expect(task).not.toHaveProperty('activeForm');
    });

    it('should sort tasks by createdAt then id', () => {
      feature.createTask('B');
      feature.createTask('A');

      const snapshot = feature.getPlanSnapshot();
      expect(snapshot.tasks[0].subject).toBe('B');
      expect(snapshot.tasks[1].subject).toBe('A');
    });
  });

  // ========== getTemplateNames ==========

  describe('getTemplateNames()', () => {
    it('should return 4 template names (no task-get)', () => {
      const names = feature.getTemplateNames();
      expect(names).toHaveLength(4);
      expect(names).toContain('task-create');
      expect(names).toContain('task-list');
      expect(names).toContain('task-update');
      expect(names).toContain('task-clear');
      expect(names).not.toContain('task-get');
    });
  });
});
