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

  // ========== 注入渲染（CallStart / 阈值 reminder 全量可见） ==========

  describe('CallStart injection', () => {
    function makeCallStartCtx() {
      const added: Array<{ role: string; content: string }> = [];
      return {
        added,
        ctx: {
          isFirstCall: false,
          context: { add: (m: { role: string; content: string }) => added.push(m) },
        },
      } as any;
    }

    it('injects every active task, including skipped/stale ones', async () => {
      // 用户场景复刻：A B C 完成后跳过 D，创建并执行 E、F
      feature.createTask('A');
      feature.createTask('B');
      feature.createTask('C');
      feature.createTask('D 被跳过的任务');
      feature.createTask('E 新目标');
      feature.createTask('F 新目标');
      feature.updateTask('1', { status: 'completed' });
      feature.updateTask('2', { status: 'completed' });
      feature.updateTask('3', { status: 'completed' });
      feature.updateTask('5', { status: 'in_progress' });

      const { added, ctx } = makeCallStartCtx();
      await feature.onCallStart(ctx);

      expect(added).toHaveLength(1);
      expect(added[0].role).toBe('system');
      const text = added[0].content;
      // 被跳过的 D 与新任务 E、F 全部可见
      expect(text).toContain('D 被跳过的任务');
      expect(text).toContain('E 新目标');
      expect(text).toContain('F 新目标');
      // 已完成任务不进入注入
      expect(text).not.toMatch(/- #1 \[/);
      expect(text).not.toMatch(/- #2 \[/);
      expect(text).not.toMatch(/- #3 \[/);
      // 维护提示：不再适用时同步状态（完成或取消）
      expect(text).toContain('调整或取消');
      expect(text).toContain('同步状态');
    });

    it('does not inject when no active tasks', async () => {
      feature.createTask('A');
      feature.updateTask('1', { status: 'completed' });

      const { added, ctx } = makeCallStartCtx();
      await feature.onCallStart(ctx);
      expect(added).toHaveLength(0);
    });

    it('does not inject on first call', async () => {
      feature.createTask('A');
      const { added, ctx } = makeCallStartCtx();
      ctx.isFirstCall = true;
      await feature.onCallStart(ctx);
      expect(added).toHaveLength(0);
    });

    it('caps listed tasks and notes the omitted count', async () => {
      for (let i = 1; i <= 25; i++) {
        feature.createTask(`任务 ${i}`);
      }
      const { added, ctx } = makeCallStartCtx();
      await feature.onCallStart(ctx);

      const text = added[0].content;
      // 按 createdAt 升序取前 MAX_INJECT_TASKS(20) 项：#20 在、#21 起不可见
      expect(text).toContain('- #20 [pending] 任务 20');
      expect(text).not.toContain('- #21 [pending]');
      expect(text).toContain('其余 5 项未展示');
    });
  });

  describe('threshold reminder injection', () => {
    function makeStepStartCtx() {
      const added: Array<{ role: string; content: string }> = [];
      return {
        added,
        ctx: {
          callIndex: 5,
          context: { add: (m: { role: string; content: string }) => added.push(m) },
        },
      } as any;
    }

    it('injects full task list alongside reminder text', async () => {
      feature.createTask('正在处理的工作');
      feature.createTask('B 被搁置的任务');
      feature.updateTask('1', { status: 'in_progress' });
      // 连续未使用 todo 工具达到阈值（默认 withTasks=3）
      (feature as any).consecutiveNoTodoTurns = 3;

      const { added, ctx } = makeStepStartCtx();
      await feature.checkAndInjectReminder(ctx);

      expect(added).toHaveLength(1);
      const text = added[0].content;
      // 完整列表与温和提醒尾部同时在场，证明两者被拼接而非互相替代
      expect(text).toContain('[当前任务计划]');
      expect(text).toContain('- #1 [in_progress] 正在处理的工作');
      expect(text).toContain('- #2 [pending] B 被搁置的任务');
      expect(text).toContain('温和的提醒');
    });
  });

  // ========== deliver 字段 ==========

  describe('deliver field', () => {
    it('stores deliver from createTask options', () => {
      const task = feature.createTask('修复登录', '描述', { deliver: 'test/auth.test.js 全部通过' });
      expect(task.deliver).toBe('test/auth.test.js 全部通过');
    });

    it('updates deliver via updateTask', () => {
      feature.createTask('修复登录', '描述');
      const updated = feature.updateTask('1', { status: 'completed', deliver: 'src/auth.ts 已提交' });
      expect(updated!.deliver).toBe('src/auth.ts 已提交');
    });

    it('includes deliver in listTasks summaries', () => {
      feature.createTask('修复登录', '描述', { deliver: '测试通过' });
      expect(feature.listTasks()[0].deliver).toBe('测试通过');
    });

    it('includes deliver in plan snapshot', () => {
      feature.createTask('修复登录', '描述', { deliver: '测试通过' });
      expect(feature.getPlanSnapshot().tasks[0].deliver).toBe('测试通过');
    });

    it('preserves deliver across capture/restore', () => {
      feature.createTask('修复登录', '描述', { deliver: '测试通过' });
      const snapshot = feature.captureState();

      const fresh = new TodoFeature();
      fresh.restoreState(snapshot);

      expect(fresh.getTask('1')!.deliver).toBe('测试通过');
    });

    it('task_create tool passes deliver through', async () => {
      const createTool = feature.getTools().find(t => t.name === 'task_create')!;
      const result: any = await createTool.execute({ subject: '修复登录', deliver: 'test/auth 通过' });
      expect(result.__withDisplay).toBe(true);
      expect(feature.getTask('1')!.deliver).toBe('test/auth 通过');
      expect(result.display.task.deliver).toBe('test/auth 通过');
    });

    it('renders deliver line in CallStart injection', async () => {
      feature.createTask('修复登录', '描述', { deliver: 'test/auth.test.js 通过' });
      feature.updateTask('1', { status: 'in_progress' });
      const added: Array<{ role: string; content: string }> = [];
      const ctx = {
        isFirstCall: false,
        context: { add: (m: { role: string; content: string }) => added.push(m) },
      } as any;
      await feature.onCallStart(ctx);
      expect(added[0].content).toContain('交付: test/auth.test.js 通过');
    });
  });

  // ========== task_update 单 in_progress 硬约束 ==========

  describe('single in_progress constraint (task_update tool)', () => {
    function getUpdateTool() {
      return feature.getTools().find(t => t.name === 'task_update')!;
    }

    it('rejects starting a second task while another is in_progress, naming the blocker', async () => {
      feature.createTask('任务甲');
      feature.createTask('任务乙');
      const first: any = await getUpdateTool().execute({ taskId: '1', status: 'in_progress' });
      expect(first.__withDisplay).toBe(true);

      const rejected: any = await getUpdateTool().execute({ taskId: '2', status: 'in_progress' });
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toContain('#1');
      expect(rejected.error).toContain('任务甲');
      // 拒绝时状态未被修改
      expect(feature.getTask('2')!.status).toBe('pending');
    });

    it('allows starting the next task after the blocker is completed', async () => {
      feature.createTask('任务甲');
      feature.createTask('任务乙');
      await getUpdateTool().execute({ taskId: '1', status: 'in_progress' });
      await getUpdateTool().execute({ taskId: '1', status: 'completed', deliver: '已交付' });
      const result: any = await getUpdateTool().execute({ taskId: '2', status: 'in_progress' });
      expect(result.__withDisplay).toBe(true);
      expect(feature.getTask('2')!.status).toBe('in_progress');
    });

    it('allows idempotent re-asserting in_progress on the same task', async () => {
      feature.createTask('任务甲');
      await getUpdateTool().execute({ taskId: '1', status: 'in_progress' });
      const result: any = await getUpdateTool().execute({ taskId: '1', status: 'in_progress' });
      expect(result.__withDisplay).toBe(true);
    });

    it('allows completing or cancelling other tasks while one is in_progress', async () => {
      feature.createTask('任务甲');
      feature.createTask('任务乙');
      feature.createTask('任务丙');
      await getUpdateTool().execute({ taskId: '1', status: 'in_progress' });
      const completed: any = await getUpdateTool().execute({ taskId: '2', status: 'completed' });
      const deleted: any = await getUpdateTool().execute({ taskId: '3', status: 'deleted' });
      expect(completed.__withDisplay).toBe(true);
      expect(deleted.__withDisplay).toBe(true);
    });

    it('internal updateTask API is not constrained', () => {
      // 约束只在模型工具层；内部 API（ControlledTodoFeature 等编程调用）不受限
      feature.createTask('任务甲');
      feature.createTask('任务乙');
      feature.updateTask('1', { status: 'in_progress' });
      const second = feature.updateTask('2', { status: 'in_progress' });
      expect(second!.status).toBe('in_progress');
    });
  });
});
