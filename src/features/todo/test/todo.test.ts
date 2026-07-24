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
    it('should return 5 tools', () => {
      const tools = feature.getTools();
      expect(tools).toHaveLength(5);
    });

    it('should register tools with correct names', () => {
      const tools = feature.getTools();
      const names = tools.map(t => t.name);
      expect(names).toContain('task_create');
      expect(names).toContain('task_list');
      expect(names).toContain('task_get');
      expect(names).toContain('task_update');
      expect(names).toContain('task_clear');
    });
  });

  // ========== 任务 CRUD ==========

  describe('createTask()', () => {
    it('should create a task with pending status', () => {
      const task = feature.createTask('Fix bug', 'Fix the login bug', 'Fixing the login bug');
      expect(task.id).toBe('1');
      expect(task.subject).toBe('Fix bug');
      expect(task.description).toBe('Fix the login bug');
      expect(task.activeForm).toBe('Fixing the login bug');
      expect(task.status).toBe('pending');
      expect(task.blocks).toEqual([]);
      expect(task.blockedBy).toEqual([]);
    });

    it('should increment counter for each task', () => {
      const t1 = feature.createTask('Task 1', 'Desc 1', 'Doing 1');
      const t2 = feature.createTask('Task 2', 'Desc 2', 'Doing 2');
      const t3 = feature.createTask('Task 3', 'Desc 3', 'Doing 3');
      expect(t1.id).toBe('1');
      expect(t2.id).toBe('2');
      expect(t3.id).toBe('3');
    });

    it('should support metadata and owner', () => {
      const task = feature.createTask('Task', 'Desc', 'Doing', {
        owner: 'agent_1',
        metadata: { priority: 'high' },
      });
      expect(task.owner).toBe('agent_1');
      expect(task.metadata).toEqual({ priority: 'high' });
    });
  });

  describe('getTask()', () => {
    it('should return task by id', () => {
      feature.createTask('Task 1', 'Desc 1', 'Doing 1');
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
      feature.createTask('Task A', 'Desc A', 'Doing A');
      feature.createTask('Task B', 'Desc B', 'Doing B');
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
      expect(tasks[0]).toHaveProperty('blockedBy');
    });
  });

  describe('updateTask()', () => {
    it('should update task status', () => {
      feature.createTask('Task', 'Desc', 'Doing');
      const updated = feature.updateTask('1', { status: 'in_progress' });
      expect(updated!.status).toBe('in_progress');
    });

    it('should add blocks', () => {
      feature.createTask('Task', 'Desc', 'Doing');
      const updated = feature.updateTask('1', { addBlocks: ['2', '3'] });
      expect(updated!.blocks).toEqual(['2', '3']);
    });

    it('should add blockedBy', () => {
      feature.createTask('Task', 'Desc', 'Doing');
      const updated = feature.updateTask('1', { addBlockedBy: ['2'] });
      expect(updated!.blockedBy).toEqual(['2']);
    });

    it('should deduplicate blocks', () => {
      feature.createTask('Task', 'Desc', 'Doing');
      feature.updateTask('1', { addBlocks: ['2', '3'] });
      const updated = feature.updateTask('1', { addBlocks: ['2', '4'] });
      expect(updated!.blocks).toEqual(['2', '3', '4']);
    });

    it('should return undefined for non-existent task', () => {
      const updated = feature.updateTask('999', { status: 'completed' });
      expect(updated).toBeUndefined();
    });

    it('should update subject and description', () => {
      feature.createTask('Old', 'Old desc', 'Old doing');
      const updated = feature.updateTask('1', { subject: 'New', description: 'New desc' });
      expect(updated!.subject).toBe('New');
      expect(updated!.description).toBe('New desc');
    });
  });

  describe('clearTasks()', () => {
    it('should mark pending tasks as deleted', () => {
      feature.createTask('Task 1', 'Desc 1', 'Doing 1');
      feature.createTask('Task 2', 'Desc 2', 'Doing 2');
      feature.clearTasks();
      const t1 = feature.getTask('1');
      const t2 = feature.getTask('2');
      expect(t1!.status).toBe('deleted');
      expect(t2!.status).toBe('deleted');
    });

    it('should mark in_progress tasks as deleted', () => {
      feature.createTask('Task 1', 'Desc 1', 'Doing 1');
      feature.updateTask('1', { status: 'in_progress' });
      feature.clearTasks();
      const t1 = feature.getTask('1');
      expect(t1!.status).toBe('deleted');
    });

    it('should preserve completed tasks', () => {
      feature.createTask('Task 1', 'Desc 1', 'Doing 1');
      feature.updateTask('1', { status: 'completed' });
      feature.clearTasks();
      const t1 = feature.getTask('1');
      expect(t1!.status).toBe('completed');
    });
  });

  // ========== 状态转换 ==========

  describe('state transitions', () => {
    it('should support pending → in_progress → completed', () => {
      feature.createTask('Task', 'Desc', 'Doing');
      expect(feature.getTask('1')!.status).toBe('pending');

      feature.updateTask('1', { status: 'in_progress' });
      expect(feature.getTask('1')!.status).toBe('in_progress');

      feature.updateTask('1', { status: 'completed' });
      expect(feature.getTask('1')!.status).toBe('completed');
    });

    it('should support deletion via status update', () => {
      feature.createTask('Task', 'Desc', 'Doing');
      feature.updateTask('1', { status: 'deleted' });
      expect(feature.getTask('1')!.status).toBe('deleted');
    });
  });

  // ========== captureState / restoreState ==========

  describe('captureState() / restoreState()', () => {
    it('should capture tasks and counter', () => {
      feature.createTask('Task 1', 'Desc 1', 'Doing 1');
      feature.createTask('Task 2', 'Desc 2', 'Doing 2');
      const snapshot = feature.captureState() as { tasks: TodoTask[]; counter: number };

      expect(snapshot.counter).toBe(2);
      expect(snapshot.tasks).toHaveLength(2);
    });

    it('should restore tasks and counter', () => {
      feature.createTask('Task 1', 'Desc 1', 'Doing 1');
      const snapshot = feature.captureState();

      const fresh = new TodoFeature();
      fresh.restoreState(snapshot);

      expect(fresh.getTask('1')).toBeDefined();
      expect(fresh.getTask('1')!.subject).toBe('Task 1');
    });

    it('should restore counter correctly', () => {
      feature.createTask('A', 'a', 'a');
      feature.createTask('B', 'b', 'b');
      feature.createTask('C', 'c', 'c');
      const snapshot = feature.captureState();

      const fresh = new TodoFeature();
      fresh.restoreState(snapshot);

      // Next task should be id=4
      const t4 = fresh.createTask('D', 'd', 'd');
      expect(t4.id).toBe('4');
    });
  });

  // ========== getPlanSnapshot ==========

  describe('getPlanSnapshot()', () => {
    it('should return correct summary counts', () => {
      feature.createTask('A', 'a', 'a');
      feature.createTask('B', 'b', 'b');
      feature.createTask('C', 'c', 'c');
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

    it('should count blocked tasks', () => {
      feature.createTask('A', 'a', 'a');
      feature.createTask('B', 'b', 'b');
      feature.updateTask('2', { addBlockedBy: ['1'] });

      const snapshot = feature.getPlanSnapshot();
      expect(snapshot.summary.blocked).toBe(1);
    });

    it('should sort tasks by createdAt then id', () => {
      feature.createTask('B', 'b', 'b');
      feature.createTask('A', 'a', 'a');

      const snapshot = feature.getPlanSnapshot();
      expect(snapshot.tasks[0].subject).toBe('B');
      expect(snapshot.tasks[1].subject).toBe('A');
    });
  });
});
