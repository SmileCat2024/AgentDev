#!/usr/bin/env node

import { copyFileSync, existsSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const distDir = join(rootDir, 'dist');

// 1. viewer.js / server.js 由 tsup 直接输出到 dist/cli/，已自带 #!/usr/bin/env node shebang。
//    npm 在安装时会根据 bin 条目自动在 Windows 上创建 .cmd 包装，Unix 上创建可执行 symlink。
//    无需手动生成 .cmd 文件。

// 2. 打包 create-feature CLI 到 dist/
const createFeatureSrc = join(rootDir, 'packages', 'create-feature', 'dist', 'cli.js');
const createFeatureDst = join(distDir, 'create-feature-cli.js');

if (existsSync(createFeatureSrc)) {
  copyFileSync(createFeatureSrc, createFeatureDst);
  if (process.platform !== 'win32') {
    chmodSync(createFeatureDst, 0o755);
  }
  console.log('Bundled create-feature CLI into dist/');
} else {
  console.warn('WARN: packages/create-feature/dist/cli.js not found, skipping');
  console.warn('  Run "cd packages/create-feature && npm run build" first');
}
