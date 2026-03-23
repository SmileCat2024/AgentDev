#!/usr/bin/env node

import { copyFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');
const distCliDir = join(distDir, 'cli');

// 1. 生成 viewer / server .cmd 文件
const viewerCmd = `@echo off\nnode "%~dp0\\viewer.js" %*\n`;
const serverCmd = `@echo off\nnode "%~dp0\\server.js" %*\n`;

writeFileSync(join(distCliDir, 'viewer.cmd'), viewerCmd, 'utf-8');
writeFileSync(join(distCliDir, 'server.cmd'), serverCmd, 'utf-8');
console.log('Generated .cmd files for viewer / server');

// 2. 打包 create-feature CLI 到 dist/
const createFeatureSrc = join(rootDir, 'packages', 'create-feature', 'dist', 'cli.js');
const createFeatureDst = join(distDir, 'create-feature-cli.js');

if (existsSync(createFeatureSrc)) {
  copyFileSync(createFeatureSrc, createFeatureDst);

  const createFeatureCmd = `@echo off\nnode "%~dp0\\create-feature-cli.js" %*\n`;
  writeFileSync(join(distDir, 'create-feature-cli.cmd'), createFeatureCmd, 'utf-8');

  console.log('Bundled create-feature CLI into dist/');
} else {
  console.warn('WARN: packages/create-feature/dist/cli.js not found, skipping');
  console.warn('  Run "cd packages/create-feature && npm run build" first');
}
