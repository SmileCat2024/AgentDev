#!/usr/bin/env node

/**
 * core 依赖纪律断言（ADR-0003 决策 3，票 010 步骤 6）：
 *
 * `@agentdev/core` 必须保持：
 *   - 零原生依赖（需编译源码 / 含二进制 .node 的包）
 *   - 零重 SDK（openai、@openai/agents、anthropic 等大体积 SDK）
 *   - 零 feature 包反向依赖（core 永不 import packages/* 生态包）
 *
 * CI 在任何 core 相关改动后运行本脚本，违例即失败。
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const corePkgPath = join(root, 'packages', 'core', 'package.json');

// 重 SDK / 原生二进制基线（按包名前缀匹配；score 原生/OCaml 属良性可加白名单，此处不放宽）。
const HEAVY_OR_NATIVE_PREFIXES = [
  'openai',            // openai / @openai/agents
  'anthropic',
  'sharp',             // 原生二进制
  'better-sqlite3',    // 原生编译
  '@modelcontextprotocol', // MCP SDK（core 仅契约类型，不得运行时依赖）
  'sound-play',
  '@sentry',
  '@google/generative-ai',
];

// feature 生态包范围：packages/* 下除锁步组与脚手架外的目录名
const FEATURE_PREFIX = '@agentdev/';

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`✓ ${message}`);
}

function main() {
  const core = JSON.parse(readFileSync(corePkgPath, 'utf8'));
  const deps = core.dependencies || {};

  // 1. 依赖计数断言：core 应保持极简（白名单外的任何新依赖都需人工确认）
  const depNames = Object.keys(deps).sort();
  console.log(`core.dependencies (${depNames.length}): ${depNames.join(', ') || '(空)'}`);
  if (depNames.length > 10) {
    fail(`core 依赖数量过多（${depNames.length} > 10），请审查是否引入重依赖`);
  } else {
    ok(`core 依赖数量受控（${depNames.length}）`);
  }

  // 2. 零原生 / 零重 SDK
  let heavyViolation = false;
  for (const [name, range] of Object.entries(deps)) {
    for (const prefix of HEAVY_OR_NATIVE_PREFIXES) {
      if (name === prefix || name.startsWith(prefix + '/')) {
        fail(`core 不得依赖重 SDK / 原生包「${name}@${range}」`);
        heavyViolation = true;
        break;
      }
    }
  }
  if (!heavyViolation) ok('core 无重 SDK / 原生依赖');

  // 3. 零 feature 包反向依赖：core 只能依赖自身域内的基础包，不得依赖任何 @agentdev/feature-*
  const featureDeps = depNames.filter((n) => n.startsWith(FEATURE_PREFIX) && n !== '@agentdev/core');
  if (featureDeps.length) {
    fail(`core 不得反向依赖 feature 生态包：${featureDeps.join(', ')}`);
  } else {
    ok('core 无 feature 生态包反向依赖');
  }

  if (process.exitCode === undefined) {
    console.log('\ncore 依赖纪律校验通过。');
  } else {
    console.error('\ncore 依赖纪律校验失败。');
  }
}

main();
