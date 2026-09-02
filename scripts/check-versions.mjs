#!/usr/bin/env node

/**
 * 锁步版本校验：@agentdevjs/core / @agentdevjs/llm / @agentdevjs/viewer / @agentdevjs/mcp
 * 必须共享完全一致的 version 字段（ADR-0003 决策 5，票 010 步骤 1）。
 *
 * 良好的锁步纪律也要求这些包对 `@agentdevjs/core` 的依赖使用与自身版本
 * 完全一致的精确版本号（exact pin，无 caret/tilde range）。锁步包永远
 * 同版本同批发布，exact 依赖让 registry 上不存在任何可漂移的版本组合，
 * 消费端不可能解析出「llm 0.1.x 配 core 0.2.x」这类错位实例。
 *
 * 任一包失败都以非零退出码结束，供 CI 门禁使用。
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const packagesDir = join(root, 'packages');

// 锁步组：一旦对外发布，版本必须以同一版本号同步推进。
const LOCKSTEP = ['core', 'llm', 'viewer', 'mcp'];

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`✓ ${message}`);
}

function main() {
  const packageJsons = new Map();
  for (const name of LOCKSTEP) {
    packageJsons.set(name, readJson(join(packagesDir, name, 'package.json')));
  }

  // 1. 锁步组版本完全一致
  const versions = [...packageJsons.values()].map((p) => p.version);
  const uniqueVersions = new Set(versions);
  if (uniqueVersions.size !== 1) {
    fail(`锁步组版本不一致：${LOCKSTEP.map((n) => `${n}@${packageJsons.get(n).version}`).join(', ')}`);
  } else {
    ok(`锁步组版本一致：@agentdevjs/* = ${versions[0]}`);
  }

  // 2. 依赖 core 的包，必须精确依赖锁步版本（exact pin）
  for (const name of LOCKSTEP) {
    const pkg = packageJsons.get(name);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    const coreSpec = deps['@agentdevjs/core'];
    if (!coreSpec) continue; // core 自身不依赖 core
    const expected = versions[0];
    if (coreSpec !== expected) {
      fail(`${name} 对 @agentdevjs/core 的依赖 "${coreSpec}" 不是锁步精确版本 "${expected}"`);
    } else {
      ok(`${name} 的 @agentdevjs/core 依赖精确对齐锁步版本 ${expected}`);
    }
  }

  if (process.exitCode === undefined) {
    console.log('\n锁步版本校验通过。');
  } else {
    console.error('\n锁步版本校验失败。');
  }
}

main();
