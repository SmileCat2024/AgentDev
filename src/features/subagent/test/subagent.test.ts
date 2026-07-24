import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SubAgentFeature, AgentPool } from '../index.js';
import { SubAgentToolFactory } from '../tools.js';
import { Decision } from '../../../core/lifecycle.js';

describe('SubAgentFeature', () => {
  let feature: SubAgentFeature;

  beforeEach(() => {
    feature = new SubAgentFeature();
  });

  // ========== 初始化 ==========

  describe('initialization', () => {
    it('should have correct name', () => {
      expect(feature.name).toBe('subagent');
    });

    it('should have no dependencies', () => {
      expect(feature.dependencies).toEqual([]);
    });

    it('should have correct description', () => {
      expect(feature.description).toContain('子代理');
    });
  });

  // ========== 工具 ==========

  describe('getTools()', () => {
    it('should return empty before _setParentAgent', () => {
      expect(feature.getTools()).toEqual([]);
    });

    it('should return 5 tools after _setParentAgent', () => {
      const mockAgent = {} as any;
      feature._setParentAgent(mockAgent);
      const tools = feature.getTools();
      expect(tools).toHaveLength(5);
    });

    it('should register correct tool names', () => {
      const mockAgent = {} as any;
      feature._setParentAgent(mockAgent);
      const tools = feature.getTools();
      const names = tools.map(t => t.name);
      expect(names).toContain('spawn_agent');
      expect(names).toContain('list_agents');
      expect(names).toContain('send_to_agent');
      expect(names).toContain('close_agent');
      expect(names).toContain('wait');
    });
  });

  // ========== 模板 ==========

  describe('getTemplateNames()', () => {
    it('should return 5 template names', () => {
      const names = feature.getTemplateNames();
      expect(names).toContain('agent-spawn');
      expect(names).toContain('agent-list');
      expect(names).toContain('agent-send');
      expect(names).toContain('agent-close');
      expect(names).toContain('wait');
    });
  });

  // ========== getContextInjectors ==========

  describe('getContextInjectors()', () => {
    it('should return injectors for all 5 tools', () => {
      const injectors = feature.getContextInjectors();
      expect(injectors.has('spawn_agent')).toBe(true);
      expect(injectors.has('list_agents')).toBe(true);
      expect(injectors.has('send_to_agent')).toBe(true);
      expect(injectors.has('close_agent')).toBe(true);
      expect(injectors.has('wait')).toBe(true);
    });
  });

  // ========== getHookDescription ==========

  describe('getHookDescription()', () => {
    it('should return description for ToolFinished/handleWaitTool', () => {
      const desc = feature.getHookDescription('ToolFinished', 'handleWaitTool');
      expect(desc).toBeDefined();
      expect(desc).toContain('wait');
    });

    it('should return description for StepFinish/handleNoToolCalls', () => {
      const desc = feature.getHookDescription('StepFinish', 'handleNoToolCalls');
      expect(desc).toBeDefined();
      expect(desc).toContain('子代理');
    });

    it('should return undefined for unknown hook', () => {
      const desc = feature.getHookDescription('CallStart', 'unknown');
      expect(desc).toBeUndefined();
    });
  });

  // ========== captureState / restoreState ==========

  describe('captureState() / restoreState()', () => {
    it('should capture empty state when pool is not initialized', () => {
      const snapshot = feature.captureState();
      expect(snapshot.counters).toEqual([]);
      expect(snapshot.hadInstances).toBe(false);
      expect(snapshot.hadActiveAgents).toBe(false);
      expect(snapshot.hadPendingMessages).toBe(false);
    });

    it('restoreState should not throw when pool is not initialized', async () => {
      await feature.restoreState({ counters: [], hadInstances: false });
      // Should not throw
    });

    it('restoreState should warn when hadInstances is true', async () => {
      const mockAgent = {} as any;
      feature._setParentAgent(mockAgent);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await feature.restoreState({ counters: [], hadInstances: true });
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('should verify CLAUDE.md contract 14: restore clears active subagents', async () => {
      const mockAgent = {} as any;
      feature._setParentAgent(mockAgent);

      // Simulate having had instances
      await feature.restoreState({
        counters: [],
        hadInstances: true,
        hadActiveAgents: true,
      });

      // After restore, pool should have no active agents
      const pool = feature.pool!;
      expect(pool.hasActiveAgents()).toBe(false);
      expect(pool.list()).toHaveLength(0);
    });
  });

  // ========== Lifecycle ==========

  describe('lifecycle', () => {
    it('onInitiate should complete without error', async () => {
      await feature.onInitiate({
        agentId: 'test',
        config: {} as any,
        logger: console as any,
        getFeature: () => undefined,
        registerTool: () => {},
      });
    });

    it('onDestroy should complete without error', async () => {
      await feature.onDestroy();
    });
  });
});

// ========== AgentPool ==========

describe('AgentPool', () => {
  let pool: AgentPool;
  let mockParent: any;

  beforeEach(() => {
    mockParent = {
      onSubAgentSpawn: vi.fn(),
      onSubAgentDestroy: vi.fn(),
      onSubAgentUpdate: vi.fn(),
      onSubAgentInterrupt: vi.fn(),
    };
    pool = new AgentPool(mockParent);
  });

  describe('list()', () => {
    it('should return empty array initially', () => {
      expect(pool.list()).toEqual([]);
    });

    it('should filter by status', () => {
      expect(pool.list('busy')).toEqual([]);
    });
  });

  describe('get()', () => {
    it('should return undefined for unknown id', () => {
      expect(pool.get('unknown')).toBeUndefined();
    });
  });

  describe('hasActiveAgents()', () => {
    it('should return false initially', () => {
      expect(pool.hasActiveAgents()).toBe(false);
    });
  });

  describe('hasPendingMessages()', () => {
    it('should return false initially', () => {
      expect(pool.hasPendingMessages()).toBe(false);
    });
  });

  describe('getRuntimeSnapshot()', () => {
    it('should return empty snapshot initially', () => {
      const snapshot = pool.getRuntimeSnapshot();
      expect(snapshot.counters).toEqual([]);
      expect(snapshot.instances).toEqual([]);
      expect(snapshot.pendingMessages).toEqual([]);
    });
  });

  describe('report() and waitForMessage()', () => {
    it('should deliver messages via report to waitForMessage', async () => {
      // Start waiting (returns a promise)
      const waitPromise = pool.waitForMessage();

      // Report a message
      await pool.report('agent_1', 'Task completed');

      const result = await waitPromise;
      expect(result.agentId).toBe('agent_1');
      expect(result.message).toBe('Task completed');
    });
  });

  describe('close() non-existent agent', () => {
    it('should not throw when closing unknown agent', async () => {
      await pool.close('unknown');
      // Should not throw
    });
  });

  describe('shutdown()', () => {
    it('should complete without error on empty pool', async () => {
      await pool.shutdown();
    });
  });

  describe('handleInterrupt() non-existent agent', () => {
    it('should not throw for unknown agent', async () => {
      await pool.handleInterrupt('unknown', 'error', 'test result');
    });
  });
});

// ========== SubAgentToolFactory ==========

describe('SubAgentToolFactory', () => {
  let factory: SubAgentToolFactory;
  let mockPool: any;

  beforeEach(() => {
    mockPool = {
      list: vi.fn().mockReturnValue([]),
      get: vi.fn(),
      hasActiveAgents: vi.fn().mockReturnValue(false),
      sendTo: vi.fn(),
      close: vi.fn(),
      spawn: vi.fn(),
    };
    factory = new SubAgentToolFactory({
      getPool: () => mockPool,
      getParentAgent: () => ({ getRegisteredAgentTypes: () => [] } as any),
    });
  });

  describe('getAllTools()', () => {
    it('should return 5 tools', () => {
      const tools = factory.getAllTools();
      expect(tools).toHaveLength(5);
    });
  });

  describe('wait tool', () => {
    it('should return error when no active agents', async () => {
      const tools = factory.getAllTools();
      const waitTool = tools.find(t => t.name === 'wait')!;
      const result = await waitTool.execute!({}, undefined as any);
      expect(result).toHaveProperty('error');
    });
  });

  describe('list_agents tool', () => {
    it('should return agent list and summary', async () => {
      const tools = factory.getAllTools();
      const listTool = tools.find(t => t.name === 'list_agents')!;
      const result = await listTool.execute!({ filter: 'all' }, undefined as any);
      expect(result).toHaveProperty('agents');
      expect(result).toHaveProperty('total');
      expect(result.agents).toEqual([]);
    });
  });

  describe('send_to_agent tool', () => {
    it('should return error when agent does not exist', async () => {
      mockPool.get = vi.fn().mockReturnValue(undefined);
      const tools = factory.getAllTools();
      const sendTool = tools.find(t => t.name === 'send_to_agent')!;
      const result = await sendTool.execute!(
        { agentId: 'unknown', message: 'test' },
        undefined as any,
      );
      expect(result).toHaveProperty('error');
    });
  });

  describe('close_agent tool', () => {
    it('should call pool.close', async () => {
      const tools = factory.getAllTools();
      const closeTool = tools.find(t => t.name === 'close_agent')!;
      await closeTool.execute!(
        { agentId: 'test_1', reason: 'manual' },
        undefined as any,
      );
      expect(mockPool.close).toHaveBeenCalledWith('test_1', 'manual');
    });
  });
});
