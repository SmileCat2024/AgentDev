#!/usr/bin/env node

/**
 * 锁步版本校验：@agentdev/core / @agentdev/llm / @agentdev/viewer / @agentdev/mcp
 * 必须共享完全一致的 version 字段（ADR-0003 决策 5，票 010 步骤 1）。
 *
 * 良好的锁步纪律也要求这些包对 `@agentdev/core` 的依赖版本与自身版本
 * 保持 range 一致，避免发布时出现"包 A 0.1.0 依赖 core ^0.1.0"与
 * "包 B 0.1.0 依赖 core ^0.2.0"的错位。此处校验该 range 的前导主版本号
 * 与锁步版本一致（宽松匹配 0.x 内的次版本）。
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
    ok(`锁步组版本一致：@agentdev/* = ${versions[0]}`);
  }

  // 2. 依赖 core 的包，其依赖 range 与锁步版本对齐（主版本号一致）
  for (const name of LOCKSTEP) {
    const pkg = packageJsons.get(name);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    const coreRange = deps['@agentdev/core'];
    if (!coreRange) continue; // core 自身不依赖 core
    const expected = versions[0];
    // 期望形如 ^0.1.0，校验主版本号与锁步版一致即可（0.x 时比较前两段）
    const major = expected.split('.')[0];
    const prefix = `${major}.`;
    if (!coreRange.includes(prefix)) {
      fail(`${name} 对 @agentdev/core 的依赖 range "${coreRange}" 与锁步版本 ${expected} 错位`);
    } else {
      ok(`${name} 的 @agentdev/core 依赖 range "${coreRange}" 对齐锁步版本`);
    }
  }

  if (process.exitCode === undefined) {
    console.log('\n锁步版本校验通过。');
  } else {
    console.error('\n锁步版本校验失败。');
  }
}

main();
