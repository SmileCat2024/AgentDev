import { describe, it, expect } from 'vitest';
import { sanitizeToolSchema } from '../src/schema-sanitizer.js';
import { compileContextForAnthropic } from '../src/anthropic.js';
import { compileContextForOpenAIResponses } from '../src/openai-responses.js';
import type { Tool } from '@agentdev/core';

function makeTool(name: string, parameters?: Record<string, unknown>): Tool {
  return {
    name,
    description: `${name} tool`,
    parameters,
    async execute() {
      return {};
    },
  } as unknown as Tool;
}

describe('sanitizeToolSchema', () => {
  it('strips $schema recursively including nested properties and array items', () => {
    const input = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        nested: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { deep: { type: 'string' } },
        },
        list: {
          type: 'array',
          items: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'string',
          },
        },
        normal: { type: 'number' },
      },
      required: ['normal'],
    };
    const out = sanitizeToolSchema(input as Record<string, unknown>);
    expect(JSON.stringify(out)).not.toContain('$schema');
    expect(out.type).toBe('object');
    expect((out.properties as Record<string, unknown>).normal).toEqual({ type: 'number' });
    expect(out.required).toEqual(['normal']);
  });

  it('falls back to an empty object schema for missing parameters', () => {
    expect(sanitizeToolSchema(undefined)).toEqual({ type: 'object', properties: {} });
  });
});

describe('adapter tool serialization strips $schema', () => {
  const tool = makeTool('probe', {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
  } as Record<string, unknown>);

  it('anthropic input_schema is sanitized', () => {
    const compiled = compileContextForAnthropic([{ role: 'user', content: 'hi' }], [tool]);
    expect(JSON.stringify(compiled.tools)).not.toContain('$schema');
    const def = compiled.tools![0] as unknown as { input_schema: Record<string, unknown> };
    expect(def.input_schema.properties).toEqual({ q: { type: 'string' } });
  });

  it('openai responses parameters are sanitized', () => {
    const compiled = compileContextForOpenAIResponses([{ role: 'user', content: 'hi' }], [tool]);
    const body = JSON.stringify(compiled);
    expect(body).not.toContain('$schema');
    const fn = (compiled as unknown as { tools: Array<Record<string, unknown>> }).tools[0];
    expect(fn.parameters).toEqual({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] });
  });
});
