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
import { existsSync, readFileSync, rmSync } from 'fs';
import { createRequire } from 'module';
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

/** 验证包目录内全部 dependencies 都可真实解析（含 file: vendor 内化依赖）。 */
function depsResolvable(pkgDir) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    return false;
  }
  if (!existsSync(join(pkgDir, 'node_modules'))) return false;
  const req = createRequire(join(pkgDir, 'package.json'));
  return Object.keys(pkg.dependencies || {}).every((dep) => {
    try {
      req.resolve(dep);
      return true;
    } catch {
      return false;
    }
  });
}

/** 安装依赖；失败时清理陈旧 lock / 半残 node_modules 后重试一次（自愈）。 */
function installDeps(pkgDir, name) {
  console.log(`\n=== ${name}（workspace 外，安装依赖）===`);
  const install = () =>
    execSync('npm install --legacy-peer-deps --no-audit --no-fund', {
      cwd: pkgDir, stdio: 'inherit', env: process.env,
    });
  try {
    install();
  } catch {
    console.log(`\n=== ${name} 安装失败，清理陈旧 lock/node_modules 后重试 ===`);
    rmSync(join(pkgDir, 'node_modules'), { recursive: true, force: true });
    rmSync(join(pkgDir, 'package-lock.json'), { force: true });
    install();
  }
}

try {
  run(`npm run build -w ${WORKSPACE_PACKAGES.join(' -w ')}`, 'workspace 包');

  for (const [dir, name] of OUT_OF_WORKSPACE) {
    const pkgDir = join(root, 'packages', dir);
    if (!existsSync(join(pkgDir, 'package.json'))) {
      console.error(`[build-all] 跳过 ${name}：包不存在 ${pkgDir}`);
      continue;
    }
    // workspace 外包裹的依赖不随根 npm install 安装。判断依据必须是
    // 「dependencies 逐个可解析」而不是「node_modules 目录存在」——此前
    // 失败的安装会留下半残的 node_modules（目录在、依赖缺），仅查目录
    // 会跳过安装直接构建失败。
    if (!depsResolvable(pkgDir)) installDeps(pkgDir, name);
    if (!depsResolvable(pkgDir)) {
      console.error(
        `\n[build-all] ${name} 依赖安装后仍无法解析。` +
        `\n常见原因：npm install 报 up to date 但包内容缺失（如 file: 依赖目标不完整）。` +
        `\n请执行清理后重试：rm -rf ${join(pkgDir, 'node_modules')} ${join(pkgDir, 'package-lock.json')} && npm run build`,
      );
      process.exit(1);
    }
    console.log(`\n=== ${name}（workspace 外，子目录构建）===`);
    execSync('npm run build', { cwd: pkgDir, stdio: 'inherit', env: process.env });
  }

  console.log('\n[build-all] 全部构建完成。');
} catch (err) {
  console.error(`\n[build-all] 构建失败：${err.message}`);
  process.exit(1);
}