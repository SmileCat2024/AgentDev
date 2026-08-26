#!/usr/bin/env node
/**
 * 一次构建全部 @agentdev/* 包（4 框架包 + create-feature + 14 生态包）。
 *
 * 全部包均为 npm workspace 成员，统一用 `npm run build -w <name>` 编排。
 * 任何一步失败都会以非零退出码结束，保证「一次 build = 全部可用」。
 */
import { execSync } from 'child_process';
import { resolve } from 'path';

const root = resolve(import.meta.dirname, '..');

// 全部 workspace 成员包（4 框架包 + create-feature + 14 生态包）
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
  '@agentdev/qqbot-feature',
  '@agentdev/rokid-bot',
  '@agentdev/shell-feature',
  '@agentdev/tts-feature',
  '@agentdev/visual-feature',
  '@agentdev/websearch-feature',
  '@agentdev/wecom-bot',
  '@agentdev/weixin-bot',
];

function run(cmd, label) {
  console.log(`\n=== ${label} ===\n> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit', env: process.env });
}

try {
  run(`npm run build -w ${WORKSPACE_PACKAGES.join(' -w ')}`, 'workspace 包');

  console.log('\n[build-all] 全部构建完成。');
} catch (err) {
  console.error(`\n[build-all] 构建失败：${err.message}`);
  process.exit(1);
}
