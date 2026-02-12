/**
 * 配置加载
 * 从 config 目录读取 JSON 配置文件
 */

import { readFile, readdir } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * 统一配置类型
 * 字段允许冗余，各 LLM 实现只取自己需要的
 */
export interface ModelConfig {
  provider: 'openai' | 'anthropic' | string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  // 未来可扩展
  region?: string;
  projectId?: string;
}

export interface AgentConfigFile {
  defaultModel: ModelConfig;
  agent: {
    maxTurns: number;
    temperature: number;
  };
}

/**
 * 获取项目根目录
 */
function getProjectRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  return resolve(dirname(__filename), '../..');
}

/**
 * 读取配置文件
 * @param name 配置文件名（不含路径和扩展名），默认 'default'
 */
export async function loadConfig(name: string = 'default'): Promise<AgentConfigFile> {
  const projectRoot = getProjectRoot();
  const configDir = join(projectRoot, 'config');
  const configPath = resolve(configDir, `${name}.json`);

  const content = await readFile(configPath, 'utf-8');
  const raw = JSON.parse(content);

  // 替换环境变量 ${VAR_NAME}
  return replaceEnvVars(raw) as AgentConfigFile;
}

/**
 * 列出所有可用的配置文件
 */
export async function listConfigs(): Promise<string[]> {
  const projectRoot = getProjectRoot();
  const configDir = join(projectRoot, 'config');

  try {
    const files = await readdir(configDir);
    return files
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

/**
 * 递归替换对象中的环境变量
 */
function replaceEnvVars(obj: any): any {
  if (typeof obj === 'string') {
    // 匹配 ${VAR_NAME} 格式
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      return process.env[varName] || '';
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(replaceEnvVars);
  }

  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = replaceEnvVars(value);
    }
    return result;
  }

  return obj;
}
