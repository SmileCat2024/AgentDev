import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/feature/templates/*.render.ts',
  ],
  format: 'esm',
  dts: true,
  clean: true,
  sourcemap: true,
  platform: 'node',
  external: [
    '@agentdev/core',
    'node:*',
    'fs', 'path', 'url', 'module', 'os', 'crypto', 'http', 'https', 'net', 'tls',
  ],
  skipNodeModulesBundle: true,
});
