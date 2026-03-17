/**
 * 复制非 TypeScript 资源文件到 dist 目录
 */

import { cpSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

/**
 * 自动发现所有 features 目录下的 templates 子目录
 */
function discoverTemplates() {
  const featuresDir = join(rootDir, 'src/features');
  const templates = [];
  
  if (!existsSync(featuresDir)) {
    return templates;
  }
  
  const entries = readdirSync(featuresDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    const featureDir = join(featuresDir, entry.name);
    const templatesDir = join(featureDir, 'templates');
    
    if (existsSync(templatesDir)) {
      templates.push({
        src: `src/features/${entry.name}/templates`,
        dest: `dist/features/${entry.name}/templates`
      });
    }
  }
  
  return templates;
}

// 需要复制的资源目录
const assets = [
  // Python 脚本（visual feature）
  { src: 'src/features/visual/python', dest: 'dist/features/visual/python' },
  // 自动发现的所有 templates 目录
  ...discoverTemplates(),
];

console.log('Copying assets to dist...');

for (const { src, dest } of assets) {
  const srcPath = join(rootDir, src);
  const destPath = join(rootDir, dest);

  if (existsSync(srcPath)) {
    mkdirSync(dirname(destPath), { recursive: true });
    cpSync(srcPath, destPath, { recursive: true });
    console.log(`  ✓ ${src} -> ${dest}`);
  } else {
    console.log(`  ⚠ ${src} not found, skipping`);
  }
}

console.log('Done!');
