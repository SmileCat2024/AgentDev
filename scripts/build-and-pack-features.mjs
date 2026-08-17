#!/usr/bin/env node

/**
 * 批量构建和打包 Feature npm 包，产物直接落到 AgentDevClaw 的 resources/features。
 *
 * 对每个包执行：npm install --legacy-peer-deps → npm run build（tsup + copy-assets）
 * → 资源完整性校验 → npm pack → 移动 tgz 到 Claw。
 *
 * 任何一个包失败都会以非零退出码结束。
 */

import { execSync } from 'child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const packagesDir = join(projectRoot, 'packages');
const outputDir = join(projectRoot, '..', 'AgentDevClaw', 'resources', 'features');

// Claw 通过 file:resources/features/*.tgz 消费的 feature 包（create-feature 是脚手架工具，lsp-feature 无本地源码目录，均不在列）
const featuresToBuild = [
  'audio-feedback-feature',
  'audit-feature',
  'feishu-bot',
  'image-reader-feature',
  'memory-feature',
  'plugin-compat-feature',
  'qqbot-feature',
  'rokid-feature',
  'shell-feature',
  'tts-feature',
  'visual-feature',
  'websearch-feature',
  'wecom-bot',
  'weixin-bot',
];

// 与各包 scripts/copy-assets.mjs 的 ASSET_EXTENSIONS 保持一致
const ASSET_EXTENSIONS = new Set([
  '.mp3', '.wav', '.ogg', '.flac',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.json',
  '.py', '.sh', '.bash', '.zsh',
  '.txt', '.md', '.rst',
  '.yml', '.yaml', '.toml', '.ini',
  '.sql', '.graphql', '.gql',
  '.html', '.css', '.scss', '.less',
  '.wasm', '.bin',
]);

function extname(filename) {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.toLowerCase().slice(idx) : '';
}

function exec(cmd, options = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { ...options, stdio: 'pipe' }).toString();
}

/** 递归收集 dir 下所有白名单资源文件的相对路径 */
function collectAssetFiles(dir, base = dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectAssetFiles(fullPath, base));
    } else if (entry.isFile() && ASSET_EXTENSIONS.has(extname(entry.name))) {
      results.push(relative(base, fullPath).replace(/\\/g, '/'));
    }
  }
  return results;
}

/**
 * 校验构建产物中的资源完整性：src/ 下每个资源文件在 dist/ 中必须存在且非空。
 * 返回问题列表（空数组 = 通过）。tsup 不复制静态资源，这一步防的就是 copy-assets 被跳过。
 */
function verifyDistAssets(packageDir) {
  const problems = [];
  const srcAssets = collectAssetFiles(join(packageDir, 'src'));
  for (const relPath of srcAssets) {
    const distPath = join(packageDir, 'dist', relPath);
    if (!existsSync(distPath)) {
      problems.push(`dist/${relPath} 缺失（copy-assets 未复制？）`);
      continue;
    }
    if (statSync(distPath).size === 0) {
      problems.push(`dist/${relPath} 为空文件`);
    }
  }
  return problems;
}

/** 跨平台移动文件（renameSync 失败时回退到 copy + delete） */
function moveFile(src, dest) {
  try {
    renameSync(src, dest);
  } catch {
    copyFileSync(src, dest);
    rmSync(src);
  }
}

async function buildAndPack(featureName) {
  const packageDir = join(packagesDir, featureName);

  if (!existsSync(packageDir)) {
    throw new Error(`Package directory not found: ${packageDir}`);
  }

  console.log(`\n📦 Building ${featureName}...`);

  console.log('  Installing dependencies...');
  exec('npm install --legacy-peer-deps', { cwd: packageDir });

  console.log('  Building...');
  exec('npm run build', { cwd: packageDir });

  const assetProblems = verifyDistAssets(packageDir);
  if (assetProblems.length > 0) {
    throw new Error(`构建产物资源不完整：\n    ${assetProblems.join('\n    ')}`);
  }

  console.log('  Packing...');
  const packOutput = exec('npm pack --json', { cwd: packageDir });
  const packInfo = JSON.parse(packOutput);
  const tgzFile = packInfo[0]?.filename;
  if (!tgzFile || !existsSync(join(packageDir, tgzFile))) {
    throw new Error(`npm pack 未产出 tgz（解析结果：${packOutput.slice(0, 200)}）`);
  }

  if (!existsSync(outputDir)) {
    throw new Error(`Output directory not found: ${outputDir}`);
  }
  moveFile(join(packageDir, tgzFile), join(outputDir, tgzFile));

  console.log(`  ✓ Created ${tgzFile}`);
  return tgzFile;
}

async function main() {
  console.log('Building and packing feature packages...\n');
  console.log(`Output directory: ${outputDir}\n`);

  const results = [];
  const failures = [];

  for (const featureName of featuresToBuild) {
    try {
      const tgzFile = await buildAndPack(featureName);
      results.push({ feature: featureName, file: tgzFile });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  ✗ Failed: ${message}`);
      failures.push({ feature: featureName, message });
    }
  }

  console.log('\n📊 Summary:');
  console.log('─'.repeat(60));
  for (const result of results) {
    console.log(`  ✓ ${result.feature} → ${result.file}`);
  }
  for (const failure of failures) {
    console.log(`  ✗ ${failure.feature} — ${failure.message.split('\n')[0]}`);
  }
  console.log(`\nTotal: ${results.length} succeeded, ${failures.length} failed → ${outputDir}`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
