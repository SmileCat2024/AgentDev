/**
 * 复制 example-feature 到指定目录
 *
 * 使用方式：
 *   node scripts/copy-example-feature.mjs ../my-features
 *   npm run copy-example ../my-features
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// 获取目标目录
const targetDir = process.argv[2];

if (!targetDir) {
  console.error('Usage: node scripts/copy-example-feature.mjs <target-directory>');
  console.error('Example: node scripts/copy-example-feature.mjs ../my-features');
  console.error('         npm run copy-example ../my-features');
  process.exit(1);
}

const absoluteTargetDir = resolve(rootDir, targetDir);
const sourceDir = join(rootDir, 'src/features/example-feature');

if (!existsSync(sourceDir)) {
  console.error(`Source directory not found: ${sourceDir}`);
  process.exit(1);
}

if (existsSync(absoluteTargetDir)) {
  console.error(`Target directory already exists: ${absoluteTargetDir}`);
  process.exit(1);
}

// 递归复制目录
function copyRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      cpSync(srcPath, destPath);
    }
  }
}

console.log(`Copying example-feature to: ${absoluteTargetDir}`);
copyRecursive(sourceDir, absoluteTargetDir);
console.log('✅ Done!');

console.log('\nNext steps:');
console.log(`  cd ${targetDir}`);
console.log(`  # Rename the feature as needed`);
console.log(`  # Edit the code`);
console.log(`  # npm install`);
console.log(`  # npm run build`);
