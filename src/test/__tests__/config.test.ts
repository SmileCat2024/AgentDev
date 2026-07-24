import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mock process.cwd BEFORE importing config.ts ---
// config.ts does `import { cwd } from 'process'` — a named import that binds
// at module load time. vi.spyOn(process, 'cwd') cannot intercept it, so we
// must mock the 'process' module itself via vi.mock (hoisted by vitest).

const { getMockCwd, setMockCwd } = vi.hoisted(() => {
  let cwd = '';
  return {
    getMockCwd: () => cwd,
    setMockCwd: (v: string) => { cwd = v; },
  };
});

vi.mock('process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('process')>();
  return {
    ...actual,
    cwd: () => getMockCwd(),
  };
});

import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadConfigSync, loadConfig, listConfigs } from '../../core/config.js';

describe('config', () => {
  let tmpDir: string;
  let configDir: string;
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'config-test-'));
    configDir = join(tmpDir, 'config');
    mkdirSync(configDir, { recursive: true });

    envBackup = {};
    setMockCwd(tmpDir);
  });

  afterEach(() => {
    // restore env
    for (const [key, val] of Object.entries(envBackup)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    envBackup = {};

    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setEnv(key: string, value: string): void {
    if (!(key in envBackup)) {
      envBackup[key] = process.env[key];
    }
    process.env[key] = value;
  }

  function deleteEnv(key: string): void {
    if (!(key in envBackup)) {
      envBackup[key] = process.env[key];
    }
    delete process.env[key];
  }

  function writeConfig(name: string, data: Record<string, unknown>): void {
    writeFileSync(join(configDir, `${name}.json`), JSON.stringify(data));
  }

  // ========== replaceEnvVars (indirect via loadConfigSync) ==========

  describe('replaceEnvVars (indirect)', () => {
    it('should replace ${VAR_NAME} in string values', () => {
      setEnv('MY_API_KEY', 'secret-123');
      writeConfig('default', {
        defaultModel: { provider: 'openai', apiKey: '${MY_API_KEY}', model: 'gpt-4' },
        agent: { maxTurns: 10, temperature: 0.7 },
      });

      const config = loadConfigSync();
      expect(config.defaultModel.apiKey).toBe('secret-123');
    });

    it('should replace unset env vars with empty string', () => {
      deleteEnv('NONEXISTENT_VAR');
      writeConfig('default', {
        defaultModel: { provider: 'openai', apiKey: '${NONEXISTENT_VAR}', model: 'gpt-4' },
        agent: { maxTurns: 10, temperature: 0.7 },
      });

      const config = loadConfigSync();
      expect(config.defaultModel.apiKey).toBe('');
    });

    it('should recursively handle nested objects', () => {
      setEnv('PROVIDER', 'anthropic');
      setEnv('MODEL_NAME', 'claude-sonnet');
      writeConfig('default', {
        defaultModel: {
          provider: '${PROVIDER}',
          apiKey: 'key',
          model: '${MODEL_NAME}',
        },
        agent: { maxTurns: 5, temperature: 0.5 },
      });

      const config = loadConfigSync();
      expect(config.defaultModel.provider).toBe('anthropic');
      expect(config.defaultModel.model).toBe('claude-sonnet');
    });

    it('should handle strings inside arrays', () => {
      setEnv('HDR_VAL', 'bearer-token');
      writeConfig('default', {
        defaultModel: {
          provider: 'openai',
          apiKey: 'key',
          model: 'gpt-4',
          customHeaders: [
            { key: 'Authorization', value: '${HDR_VAL}' },
          ],
        },
        agent: { maxTurns: 10, temperature: 0.7 },
      });

      const config = loadConfigSync();
      expect(config.defaultModel.customHeaders![0].value).toBe('bearer-token');
    });

    it('should leave non-string values unchanged', () => {
      writeConfig('default', {
        defaultModel: { provider: 'openai', apiKey: 'key', model: 'gpt-4', maxTokens: 4096 },
        agent: { maxTurns: 20, temperature: 0.9 },
      });

      const config = loadConfigSync();
      expect(config.defaultModel.maxTokens).toBe(4096);
      expect(config.agent.maxTurns).toBe(20);
      expect(config.agent.temperature).toBe(0.9);
    });

    it('should replace multiple placeholders in a single string', () => {
      setEnv('PREFIX', 'sk');
      setEnv('SUFFIX', '001');
      writeConfig('default', {
        defaultModel: { provider: 'openai', apiKey: '${PREFIX}-${SUFFIX}', model: 'gpt-4' },
        agent: { maxTurns: 10, temperature: 0.7 },
      });

      const config = loadConfigSync();
      expect(config.defaultModel.apiKey).toBe('sk-001');
    });

    it('should leave strings without placeholders unchanged', () => {
      writeConfig('default', {
        defaultModel: { provider: 'openai', apiKey: 'plain-key', model: 'gpt-4' },
        agent: { maxTurns: 10, temperature: 0.7 },
      });

      const config = loadConfigSync();
      expect(config.defaultModel.apiKey).toBe('plain-key');
    });
  });

  // ========== loadConfigSync ==========

  describe('loadConfigSync', () => {
    it('should read and parse JSON config file', () => {
      writeConfig('default', {
        defaultModel: { provider: 'openai', apiKey: 'key', model: 'gpt-4' },
        agent: { maxTurns: 10, temperature: 0.7 },
      });

      const config = loadConfigSync();
      expect(config.defaultModel.provider).toBe('openai');
      expect(config.defaultModel.model).toBe('gpt-4');
      expect(config.agent.maxTurns).toBe(10);
    });

    it('should throw an error containing the path when config file does not exist', () => {
      expect(() => loadConfigSync('nonexistent')).toThrow(/config.*nonexistent\.json/i);
    });

    it('should support custom config name', () => {
      writeConfig('custom', {
        defaultModel: { provider: 'anthropic', apiKey: 'custom-key', model: 'claude' },
        agent: { maxTurns: 3, temperature: 0.1 },
      });

      const config = loadConfigSync('custom');
      expect(config.defaultModel.provider).toBe('anthropic');
      expect(config.defaultModel.apiKey).toBe('custom-key');
      expect(config.agent.maxTurns).toBe(3);
    });

    it('should replace env vars in the loaded config', () => {
      setEnv('ENV_KEY', 'env-value');
      writeConfig('default', {
        defaultModel: { provider: 'openai', apiKey: '${ENV_KEY}', model: 'gpt-4' },
        agent: { maxTurns: 10, temperature: 0.7 },
      });

      const config = loadConfigSync();
      expect(config.defaultModel.apiKey).toBe('env-value');
    });
  });

  // ========== loadConfig (async) ==========

  describe('loadConfig (async)', () => {
    it('should read and parse JSON config file', async () => {
      writeConfig('default', {
        defaultModel: { provider: 'openai', apiKey: 'async-key', model: 'gpt-4' },
        agent: { maxTurns: 7, temperature: 0.3 },
      });

      const config = await loadConfig();
      expect(config.defaultModel.provider).toBe('openai');
      expect(config.defaultModel.apiKey).toBe('async-key');
      expect(config.agent.temperature).toBe(0.3);
    });

    it('should throw when config file does not exist', async () => {
      await expect(loadConfig('nonexistent')).rejects.toThrow(/配置文件不存在/);
    });

    it('should replace env vars in the loaded config', async () => {
      setEnv('ASYNC_VAR', 'async-val');
      writeConfig('default', {
        defaultModel: { provider: 'openai', apiKey: '${ASYNC_VAR}', model: 'gpt-4' },
        agent: { maxTurns: 10, temperature: 0.7 },
      });

      const config = await loadConfig();
      expect(config.defaultModel.apiKey).toBe('async-val');
    });
  });

  // ========== listConfigs ==========

  describe('listConfigs', () => {
    it('should list all .json config files without extension', async () => {
      writeConfig('alpha', {
        defaultModel: { provider: 'openai', apiKey: 'k', model: 'm' },
        agent: { maxTurns: 1, temperature: 0 },
      });
      writeConfig('beta', {
        defaultModel: { provider: 'openai', apiKey: 'k', model: 'm' },
        agent: { maxTurns: 1, temperature: 0 },
      });
      writeFileSync(join(configDir, 'readme.txt'), 'not a config');

      const configs = await listConfigs();
      expect(configs).toContain('alpha');
      expect(configs).toContain('beta');
      expect(configs).not.toContain('readme');
      expect(configs).toHaveLength(2);
    });

    it('should return empty array when config directory does not exist', async () => {
      rmSync(configDir, { recursive: true, force: true });
      const configs = await listConfigs();
      expect(configs).toEqual([]);
    });
  });
});
