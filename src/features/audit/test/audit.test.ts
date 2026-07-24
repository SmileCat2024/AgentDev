import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuditFeature } from '../index.js';
import { Decision } from '../../../core/lifecycle.js';

describe('AuditFeature', () => {
  let feature: AuditFeature;

  beforeEach(() => {
    // Disable cache to avoid database I/O
    feature = new AuditFeature({ enableCache: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ========== 初始化 ==========

  describe('initialization', () => {
    it('should have correct name', () => {
      expect(feature.name).toBe('audit');
    });

    it('should have no dependencies', () => {
      expect(feature.dependencies).toEqual([]);
    });

    it('should have correct description', () => {
      expect(feature.description).toContain('审计');
    });

    it('should accept custom config', () => {
      const f = new AuditFeature({
        baseUrl: 'http://custom:1234',
        model: 'custom-model',
        enabled: false,
        enableCache: false,
      });
      expect(f).toBeDefined();
    });

    it('should default to localhost:7575', () => {
      const f = new AuditFeature({ enableCache: false });
      expect(f).toBeDefined();
    });
  });

  // ========== 工具 ==========

  describe('getTools()', () => {
    it('should return empty array (no tools exposed)', () => {
      expect(feature.getTools()).toEqual([]);
    });
  });

  // ========== getHookDescription ==========

  describe('getHookDescription()', () => {
    it('should return description for ToolUse/auditBashCommand', () => {
      const desc = feature.getHookDescription('ToolUse', 'auditBashCommand');
      expect(desc).toBeDefined();
      expect(desc).toContain('审计');
    });

    it('should return undefined for unknown hook', () => {
      const desc = feature.getHookDescription('StepStart', 'unknown');
      expect(desc).toBeUndefined();
    });
  });

  // ========== formatAuditMessage (private, accessed via cast) ==========

  describe('formatAuditMessage() (private)', () => {
    it('should format a malicious result with threat types', () => {
      const result = (feature as any).formatAuditMessage('rm -rf /', {
        is_malicious: true,
        risk_level: 'Critical',
        threat_types: ['data_destruction', 'privilege_escalation'],
        analysis: 'Dangerous recursive delete',
        obfuscation_detected: false,
      });

      expect(result).toContain('安全审计拦截');
      expect(result).toContain('Critical');
      expect(result).toContain('data_destruction');
      expect(result).toContain('privilege_escalation');
      expect(result).toContain('Dangerous recursive delete');
    });

    it('should show "无" when threat_types is empty', () => {
      const result = (feature as any).formatAuditMessage('ls -la', {
        is_malicious: false,
        risk_level: 'Low',
        threat_types: [],
        analysis: 'Safe listing command',
        obfuscation_detected: false,
      });

      expect(result).toContain('无');
    });

    it('should include the original command in the message', () => {
      const result = (feature as any).formatAuditMessage('curl http://evil.com', {
        is_malicious: true,
        risk_level: 'High',
        threat_types: ['network_exfiltration'],
        analysis: 'Suspicious network call',
        obfuscation_detected: true,
      });

      expect(result).toContain('curl http://evil.com');
    });
  });

  // ========== auditBashCommand logic (via mock context) ==========

  describe('auditBashCommand() with disabled feature', () => {
    it('should return Continue when feature is disabled', async () => {
      const disabledFeature = new AuditFeature({ enabled: false, enableCache: false });
      const ctx = {
        call: { name: 'bash', arguments: { command: 'ls' } },
        context: { add: vi.fn() },
      };
      const result = await (disabledFeature as any).auditBashCommand(ctx);
      expect(result).toBe(Decision.Continue);
    });
  });

  describe('auditBashCommand() skip logic', () => {
    it('should return Continue for non-bash tools', async () => {
      const ctx = {
        call: { name: 'read', arguments: { filePath: 'test.ts' } },
        context: { add: vi.fn() },
      };
      const result = await (feature as any).auditBashCommand(ctx);
      expect(result).toBe(Decision.Continue);
    });

    it('should return Continue when command is missing', async () => {
      const ctx = {
        call: { name: 'bash', arguments: {} },
        context: { add: vi.fn() },
      };
      const result = await (feature as any).auditBashCommand(ctx);
      expect(result).toBe(Decision.Continue);
    });

    it('should return Continue when command is not a string', async () => {
      const ctx = {
        call: { name: 'bash', arguments: { command: 123 } },
        context: { add: vi.fn() },
      };
      const result = await (feature as any).auditBashCommand(ctx);
      expect(result).toBe(Decision.Continue);
    });
  });

  // ========== auditCommand (private, LLM call) ==========

  describe('auditCommand() (private)', () => {
    it('should parse LLM JSON response correctly', async () => {
      // Mock the OpenAI client
      (feature as any).client = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{
                message: {
                  content: JSON.stringify({
                    is_malicious: false,
                    risk_level: 'Low',
                    threat_types: [],
                    analysis: 'Safe command',
                    obfuscation_detected: false,
                  }),
                },
              }],
            }),
          },
        },
      };

      const result = await (feature as any).auditCommand('ls -la');
      expect(result.is_malicious).toBe(false);
      expect(result.risk_level).toBe('Low');
      expect(result.analysis).toBe('Safe command');
    });

    it('should strip markdown code block from response', async () => {
      (feature as any).client = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{
                message: {
                  content: '```json\n' + JSON.stringify({
                    is_malicious: true,
                    risk_level: 'High',
                    threat_types: ['privilege_escalation'],
                    analysis: 'Dangerous',
                    obfuscation_detected: false,
                  }) + '\n```',
                },
              }],
            }),
          },
        },
      };

      const result = await (feature as any).auditCommand('sudo rm -rf /');
      expect(result.is_malicious).toBe(true);
      expect(result.risk_level).toBe('High');
    });

    it('should throw on invalid is_malicious type', async () => {
      (feature as any).client = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{
                message: {
                  content: JSON.stringify({
                    is_malicious: 'yes',
                    risk_level: 'Low',
                    threat_types: [],
                    analysis: 'Safe',
                    obfuscation_detected: false,
                  }),
                },
              }],
            }),
          },
        },
      };

      await expect((feature as any).auditCommand('ls')).rejects.toThrow('Invalid audit result');
    });
  });

  // ========== Lifecycle ==========

  describe('lifecycle', () => {
    it('onInitiate should complete without error (no cache)', async () => {
      await feature.onInitiate({
        agentId: 'test',
        config: {} as any,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
        getFeature: () => undefined,
        registerTool: () => {},
      });
    });

    it('onDestroy should complete without error', async () => {
      await feature.onDestroy({
        agentId: 'test',
        config: {} as any,
        getFeature: () => undefined,
      });
    });
  });
});
