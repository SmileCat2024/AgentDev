import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/cli/viewer.ts',
    'src/cli/server.ts',
  ],
  format: 'esm',
  dts: true,
  clean: true,
  sourcemap: true,
  platform: 'node',
  external: [
    '@agentdevjs/core',
    'node:*',
    'fs', 'path', 'url', 'module', 'os', 'crypto', 'http', 'https', 'net', 'tls',
  ],
  skipNodeModulesBundle: true,
});
