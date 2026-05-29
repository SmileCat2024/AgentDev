import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/cli/viewer.ts',
    'src/cli/server.ts',
    'src/features/*/templates/*.render.ts'
  ],
  format: 'esm',
  dts: true,
  clean: true,
  sourcemap: true,
  platform: 'node',  // 明确 Node 环境
  external: [
    'undici',
    'node:undici',
    // 其他 Node.js 核心模块
    'node:*',
    'fs', 'path', 'url', 'module', 'os', 'crypto', 'http', 'https', 'net', 'tls'
  ],
  // 确保不打包 node_modules
  skipNodeModulesBundle: true,
});
