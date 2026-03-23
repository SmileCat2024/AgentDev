#!/usr/bin/env node

/**
 * 批量构建和打包 Feature npm 包
 */

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const packagesDir = join(projectRoot, 'packages');
const outputDir = join(projectRoot, '..', 'AgentDevFeatures');

const featuresToBuild = [
  'audio-feedback-feature',
  'audit-feature',
  'memory-feature',
  'plugin-compat-feature',
  'qqbot-feature',
  'shell-feature',
  'tts-feature',
  'visual-feature',
  'websearch-feature',
];

function exec(cmd, options = {}) {
  console.log(`  $ ${cmd}`);
  try {
    return execSync(cmd, { ...options, stdio: 'pipe' }).toString();
  } catch (error) {
    throw new Error(`Command failed: ${cmd}\n${error.message}`);
  }
}

async function buildAndPack(featureName) {
  const packageDir = join(packagesDir, featureName);

  if (!existsSync(packageDir)) {
    console.log(`⚠ Package directory not found: ${packageDir}`);
    return null;
  }

  console.log(`\n📦 Building ${featureName}...`);

  try {
    // 安装依赖
    console.log(`  Installing dependencies...`);
    exec('npm install --legacy-peer-deps', { cwd: packageDir });

    // 构建
    console.log(`  Building...`);
    exec('npm run build', { cwd: packageDir });

    // 打包
    console.log(`  Packing...`);
    const result = exec('npm pack', { cwd: packageDir });

    // 提取生成的 tgz 文件名
    const match = result.match(/agentdev-[\w-]+-\d+\.\d+\.\d+\.tgz/);
    if (match) {
      const tgzFile = match[0];
      const tgzPath = join(packageDir, tgzFile);

      // 移动到输出目录
      console.log(`  Moving to output directory...`);
      exec(`mv "${tgzPath}" "${outputDir}/"`, { shell: true });

      console.log(`  ✓ Created ${tgzFile}`);
      return tgzFile;
    }
  } catch (error) {
    console.error(`  ✗ Failed: ${error.message}`);
    return null;
  }

  return null;
}

async function main() {
  console.log('Building and packing feature packages...\n');
  console.log(`Output directory: ${outputDir}\n`);

  const results = [];

  for (const featureName of featuresToBuild) {
    const tgzFile = await buildAndPack(featureName);
    if (tgzFile) {
      results.push({ feature: featureName, file: tgzFile });
    }
  }

  console.log('\n📊 Summary:');
  console.log('─'.repeat(60));
  for (const result of results) {
    console.log(`  ✓ ${result.feature} → ${result.file}`);
  }
  console.log(`\nTotal: ${results.length} packages created in ${outputDir}`);
}

main().catch(console.error);
