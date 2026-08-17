#!/usr/bin/env node
/**
 * Copy non-TypeScript assets to dist directory
 * No external dependencies - uses only Node.js built-ins
 */

import { copyFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const srcDir = join(rootDir, 'src');
const distDir = join(rootDir, 'dist');

// Extensions to copy (non-TypeScript files)
const ASSET_EXTENSIONS = new Set([
  '.mp3', '.wav', '.ogg', '.flac',  // Audio
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',  // Images
  '.json',  // Config files
  '.py', '.sh', '.bash', '.zsh',  // Scripts
  '.txt', '.md', '.rst',  // Docs
  '.yml', '.yaml', '.toml', '.ini',  // Config
  '.sql', '.graphql', '.gql',  // Data
  '.html', '.css', '.scss', '.less',  // Styles
  '.wasm', '.bin',  // Binary
]);

function isAssetFile(filename) {
  return ASSET_EXTENSIONS.has(extname(filename));
}

function extname(filename) {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.toLowerCase().slice(idx) : '';
}

function copyDirectory(src, dest) {
  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else if (entry.isFile() && isAssetFile(entry.name)) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      const relPath = relative(rootDir, srcPath);
      console.log(`Copied: ${relPath}`);
    }
  }
}

async function copyAssets() {
  if (!existsSync(srcDir)) {
    console.log('src directory not found');
    return;
  }

  let count = 0;
  const originalLog = console.log;
  console.log = (...args) => { count++; originalLog(...args); };

  copyDirectory(srcDir, distDir);

  console.log = originalLog;
  console.log(`Copied ${count} asset(s)`);
}

function existsSync(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

copyAssets().catch(err => {
  console.error('Error copying assets:', err);
  process.exit(1);
});
