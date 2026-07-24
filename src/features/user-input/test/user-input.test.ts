import { describe, it, expect, beforeEach } from 'vitest';
import { UserInputFeature } from '../index.js';

describe('UserInputFeature', () => {
  let feature: UserInputFeature;

  beforeEach(() => {
    feature = new UserInputFeature();
  });

  // ========== 初始化 ==========

  describe('initialization', () => {
    it('should have correct name', () => {
      expect(feature.name).toBe('user-input');
    });

    it('should have no dependencies', () => {
      expect(feature.dependencies).toEqual([]);
    });

    it('should have empty template names', () => {
      expect(feature.getTemplateNames()).toEqual([]);
    });

    it('should accept timeout config', () => {
      const f = new UserInputFeature({ timeout: 5000 });
      expect(f).toBeDefined();
    });
  });

  // ========== 工具注册 ==========

  describe('getTools()', () => {
    it('should return 2 tools', () => {
      const tools = feature.getTools();
      expect(tools).toHaveLength(2);
    });

    it('should register ask_user_choice', () => {
      const tools = feature.getTools();
      expect(tools.map(t => t.name)).toContain('ask_user_choice');
    });

    it('should register ask_user_choices', () => {
      const tools = feature.getTools();
      expect(tools.map(t => t.name)).toContain('ask_user_choices');
    });

    it('should have required parameters for ask_user_choice', () => {
      const tools = feature.getTools();
      const tool = tools.find(t => t.name === 'ask_user_choice')!;
      expect(tool.parameters.required).toContain('prompt');
      expect(tool.parameters.required).toContain('question');
      expect(tool.parameters.required).toContain('options');
    });

    it('should have required parameters for ask_user_choices', () => {
      const tools = feature.getTools();
      const tool = tools.find(t => t.name === 'ask_user_choices')!;
      expect(tool.parameters.required).toContain('prompt');
      expect(tool.parameters.required).toContain('questions');
    });
  });

  // ========== setNextDraftInput ==========

  describe('setNextDraftInput()', () => {
    it('should accept a string', () => {
      feature.setNextDraftInput('hello');
      // No direct getter, but this should not throw
      expect(true).toBe(true);
    });
  });

  // ========== normalizeChoiceQuestions ==========

  describe('normalizeChoiceQuestions() (private)', () => {
    it('should throw on empty questions array', () => {
      expect(() => (feature as any).normalizeChoiceQuestions([])).toThrow('At least one');
    });

    it('should throw on missing question text', () => {
      expect(() =>
        (feature as any).normalizeChoiceQuestions([
          { id: 'q1', question: '', options: [{ id: 'a', label: 'A' }] },
        ]),
      ).toThrow('missing a question prompt');
    });

    it('should throw when options count is 0', () => {
      expect(() =>
        (feature as any).normalizeChoiceQuestions([
          { id: 'q1', question: 'Pick one', options: [] },
        ]),
      ).toThrow('1 to 4 options');
    });

    it('should throw when options count exceeds 4', () => {
      expect(() =>
        (feature as any).normalizeChoiceQuestions([
          {
            id: 'q1',
            question: 'Pick one',
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
              { id: 'c', label: 'C' },
              { id: 'd', label: 'D' },
              { id: 'e', label: 'E' },
            ],
          },
        ]),
      ).toThrow('1 to 4 options');
    });

    it('should throw on missing option label', () => {
      expect(() =>
        (feature as any).normalizeChoiceQuestions([
          { id: 'q1', question: 'Pick one', options: [{ id: 'a', label: '' }] },
        ]),
      ).toThrow('missing a label');
    });

    it('should normalize a valid question', () => {
      const result = (feature as any).normalizeChoiceQuestions([
        {
          id: 'q1',
          question: 'Which color?',
          options: [
            { id: 'red', label: 'Red', description: 'The color red' },
            { id: 'blue', label: 'Blue' },
          ],
          allowCustom: true,
          customLabel: 'Other',
        },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('q1');
      expect(result[0].question).toBe('Which color?');
      expect(result[0].options).toHaveLength(2);
      expect(result[0].options[0].id).toBe('red');
      expect(result[0].options[0].label).toBe('Red');
      expect(result[0].options[0].description).toBe('The color red');
      expect(result[0].allowCustom).toBe(true);
      expect(result[0].customLabel).toBe('Other');
    });

    it('should auto-generate question id when missing', () => {
      const result = (feature as any).normalizeChoiceQuestions([
        {
          question: 'Pick one',
          options: [{ id: 'a', label: 'A' }],
        },
      ]);
      expect(result[0].id).toBe('question_1');
    });

    it('should auto-generate option id when missing', () => {
      const result = (feature as any).normalizeChoiceQuestions([
        {
          id: 'q1',
          question: 'Pick one',
          options: [{ label: 'Option A' }],
        },
      ]);
      expect(result[0].options[0].id).toBe('option_1');
    });

    it('should default allowCustom and supplement flags to false', () => {
      const result = (feature as any).normalizeChoiceQuestions([
        {
          id: 'q1',
          question: 'Pick one',
          options: [{ id: 'a', label: 'A' }],
        },
      ]);
      expect(result[0].allowCustom).toBe(false);
      expect(result[0].options[0].allowSupplement).toBe(false);
      expect(result[0].options[0].supplementRequired).toBe(false);
    });
  });

  // ========== getHookDescription ==========

  describe('getHookDescription()', () => {
    it('should return undefined (no hooks defined)', () => {
      const desc = feature.getHookDescription?.('CallStart', 'test');
      expect(desc).toBeUndefined();
    });
  });

  // ========== onInitiate / onDestroy ==========

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
      await feature.onDestroy({
        agentId: 'test',
        config: {} as any,
        getFeature: () => undefined,
      });
    });
  });
});
