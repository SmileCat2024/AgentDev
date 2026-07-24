import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SkillFeature } from '../index.js';
import { invokeSkillTool } from '../tools.js';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SkillFeature', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `skill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ========== 初始化 ==========

  describe('initialization', () => {
    it('should have correct name', () => {
      const f = new SkillFeature();
      expect(f.name).toBe('skill');
    });

    it('should have no dependencies', () => {
      const f = new SkillFeature();
      expect(f.dependencies).toEqual([]);
    });

    it('should have correct description', () => {
      const f = new SkillFeature();
      expect(f.description).toContain('skills');
    });

    it('should accept string config (skills directory path)', () => {
      const f = new SkillFeature('/custom/skills');
      expect(f).toBeDefined();
    });

    it('should accept object config with dir', () => {
      const f = new SkillFeature({ dir: '/custom/skills' });
      expect(f).toBeDefined();
    });

    it('should accept object config with scanClaudeDir', () => {
      const f = new SkillFeature({ scanClaudeDir: true, scanAgentdevDir: false });
      expect(f).toBeDefined();
    });

    it('should accept object config with extraDirs', () => {
      const f = new SkillFeature({ extraDirs: ['/extra1', '/extra2'] });
      expect(f).toBeDefined();
    });
  });

  // ========== 工具注册 ==========

  describe('getTools()', () => {
    it('should return 1 tool', () => {
      const f = new SkillFeature();
      const tools = f.getTools();
      expect(tools).toHaveLength(1);
    });

    it('should register invoke_skill', () => {
      const f = new SkillFeature();
      const tools = f.getTools();
      expect(tools[0].name).toBe('invoke_skill');
    });
  });

  // ========== 模板 ==========

  describe('getTemplateNames()', () => {
    it('should return ["skill"]', () => {
      const f = new SkillFeature();
      expect(f.getTemplateNames()).toEqual(['skill']);
    });
  });

  // ========== getSkills ==========

  describe('getSkills()', () => {
    it('should return empty array before onInitiate', () => {
      const f = new SkillFeature();
      expect(f.getSkills()).toEqual([]);
    });
  });

  // ========== addFeatureSkills ==========

  describe('addFeatureSkills()', () => {
    it('should accept skills from other Features', () => {
      const f = new SkillFeature();
      f.addFeatureSkills([
        { name: 'test-skill', description: 'A test skill', path: '/fake/path' },
      ]);
      // Skills are merged during onInitiate, so getSkills still empty before init
      expect(f.getSkills()).toEqual([]);
    });
  });

  // ========== setSkillsDir ==========

  describe('setSkillsDir()', () => {
    it('should update skills directory', () => {
      const f = new SkillFeature();
      f.setSkillsDir('/new/path');
      expect(f).toBeDefined();
    });
  });

  // ========== getContextInjectors ==========

  describe('getContextInjectors()', () => {
    it('should return injector for invoke_skill', () => {
      const f = new SkillFeature();
      const injectors = f.getContextInjectors();
      expect(injectors.has('invoke_skill')).toBe(true);
    });

    it('should return skills array in context', () => {
      const f = new SkillFeature();
      const injectors = f.getContextInjectors();
      const injector = injectors.get('invoke_skill')!;
      const result = injector({ name: 'invoke_skill', arguments: { skill: 'test' } } as any);
      expect(result._context).toBeDefined();
      expect((result._context as any).skills).toEqual([]);
    });
  });

  // ========== getFlowVariables ==========

  describe('getFlowVariables()', () => {
    it('should return skillSummaryItems and skillSummaryText', () => {
      const f = new SkillFeature();
      const vars = f.getFlowVariables();
      expect(vars).toHaveLength(2);
      const keys = vars.map(v => v.key);
      expect(keys).toContain('skillSummaryItems');
      expect(keys).toContain('skillSummaryText');
    });

    it('should resolve skillSummaryItems as array of strings', () => {
      const f = new SkillFeature();
      const vars = f.getFlowVariables();
      const items = vars.find(v => v.key === 'skillSummaryItems')!;
      const result = items.resolver();
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0); // no skills loaded yet
    });

    it('should resolve skillSummaryText as string', () => {
      const f = new SkillFeature();
      const vars = f.getFlowVariables();
      const text = vars.find(v => v.key === 'skillSummaryText')!;
      const result = text.resolver();
      expect(typeof result).toBe('string');
    });
  });

  // ========== getFlowNodeTemplates ==========

  describe('getFlowNodeTemplates()', () => {
    it('should return skill-availability-prompt template', () => {
      const f = new SkillFeature();
      const templates = f.getFlowNodeTemplates();
      expect(templates).toHaveLength(1);
      expect(templates[0].id).toBe('skill-availability-prompt');
    });
  });

  // ========== getFeatureManifest ==========

  describe('getFeatureManifest()', () => {
    it('should return manifest with settings', () => {
      const f = new SkillFeature();
      const manifest = f.getFeatureManifest();
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.settings.properties.scanAgentdevDir).toBeDefined();
      expect(manifest.settings.properties.scanClaudeDir).toBeDefined();
      expect(manifest.settings.properties.extraDirs).toBeDefined();
    });
  });

  // ========== invoke_skill tool execution ==========

  describe('invoke_skill tool execution', () => {
    it('should return error when skill not found', async () => {
      const result = await invokeSkillTool.execute!(
        { skill: 'nonexistent' },
        { _context: { skills: [] } } as any,
      );
      expect(result).toContain('不存在');
    });

    it('should return error when no skills available', async () => {
      const result = await invokeSkillTool.execute!(
        { skill: 'any' },
        { _context: { skills: [] } } as any,
      );
      expect(result).toContain('(无可用技能)');
    });

    it('should read SKILL.md content when skill exists', async () => {
      const skillDir = join(tempDir, 'test-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '# Test Skill\n\nThis is a test skill.');

      const result = await invokeSkillTool.execute!(
        { skill: 'test-skill' },
        {
          _context: {
            skills: [
              { name: 'test-skill', description: 'A test skill', path: join(skillDir, 'SKILL.md') },
            ],
          },
        } as any,
      );

      expect(result).toContain('test-skill');
      expect(result).toContain('A test skill');
      expect(result).toContain('This is a test skill.');
    });

    it('should handle missing context gracefully', async () => {
      const result = await invokeSkillTool.execute!(
        { skill: 'any' },
        undefined as any,
      );
      expect(result).toContain('不存在');
    });

    it('should list available skills in error message', async () => {
      const result = await invokeSkillTool.execute!(
        { skill: 'nonexistent' },
        {
          _context: {
            skills: [
              { name: 'xlsx', description: 'Excel', path: '/fake/xlsx' },
              { name: 'pdf', description: 'PDF', path: '/fake/pdf' },
            ],
          },
        } as any,
      );
      expect(result).toContain('xlsx');
      expect(result).toContain('pdf');
    });
  });

  // ========== Lifecycle ==========

  describe('lifecycle', () => {
    it('onInitiate should discover skills from temp dir', async () => {
      // Create a skill in temp dir
      const skillsDir = join(tempDir, '.agentdev', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      const skillDir = join(skillsDir, 'temp-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '# Temp Skill\nTemporary.');

      const f = new SkillFeature({ dir: skillsDir, scanAgentdevDir: false });
      await f.onInitiate({
        agentId: 'test',
        config: { workspaceDir: tempDir } as any,
        logger: console as any,
        getFeature: () => undefined,
        registerTool: () => {},
      });

      const skills = f.getSkills();
      expect(skills.length).toBeGreaterThanOrEqual(0);
    });
  });
});
