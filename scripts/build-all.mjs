#!/usr/bin/env node
/**
 * 一次构建全部 @agentdev/* 包（4 框架包 + create-feature + 14 生态包）。
 *
 * 背景：根 package.json 的 workspaces 为 `packages/*` 但排除了
 * `qqbot-feature`（它依赖 file:../core，纳入 workspace 会触发 npm
 * 的循环解析）。因此：
 *   - workspace 内的包：用 `npm run build -w <name>` 编排；
 *   - 被排除的 qqbot-feature：在包目录内直接 `npm run build`。
 *
 * 任何一步失败都会以非零退出码结束，保证「一次 build = 全部可用」。
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, resolve } from 'path';

const root = resolve(import.meta.dirname, '..');

// workspace 内可构建的包（含 4 框架包 + create-feature + 13 生态包）
const WORKSPACE_PACKAGES = [
  '@agentdev/core',
  '@agentdev/llm',
  '@agentdev/viewer',
  '@agentdev/mcp',
  '@agentdev/create-feature',
  '@agentdev/audio-feedback-feature',
  '@agentdev/audit-feature',
  '@agentdev/feishu-bot',
  '@agentdev/image-reader-feature',
  '@agentdev/memory-feature',
  '@agentdev/plugin-compat-feature',
  '@agentdev/rokid-bot',
  '@agentdev/shell-feature',
  '@agentdev/tts-feature',
  '@agentdev/visual-feature',
  '@agentdev/websearch-feature',
  '@agentdev/wecom-bot',
  '@agentdev/weixin-bot',
];

// 被排除出 workspace、需在包目录内单独构建的包
const OUT_OF_WORKSPACE = [
  ['qqbot-feature', '@agentdev/qqbot-feature'],
];

function run(cmd, label) {
  console.log(`\n=== ${label} ===\n> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit', env: process.env });
}

try {
  run(`npm run build -w ${WORKSPACE_PACKAGES.join(' -w ')}`, 'workspace 包');

  for (const [dir, name] of OUT_OF_WORKSPACE) {
    const pkgDir = join(root, 'packages', dir);
    if (!existsSync(join(pkgDir, 'package.json'))) {
      console.error(`[build-all] 跳过 ${name}：包不存在 ${pkgDir}`);
      continue;
    }
    console.log(`\n=== ${name}（workspace 外，子目录构建）===`);
    execSync('npm run build', { cwd: pkgDir, stdio: 'inherit', env: process.env });
  }

  console.log('\n[build-all] 全部构建完成。');
} catch (err) {
  console.error(`\n[build-all] 构建失败：${err.message}`);
  process.exit(1);
}