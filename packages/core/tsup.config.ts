import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/features/*/templates/*.render.ts',
  ],
  format: 'esm',
  dts: true,
  clean: true,
  sourcemap: true,
  platform: 'node',
  external: [
    'node:*',
    'fs', 'path', 'url', 'module', 'os', 'crypto', 'http', 'https', 'net', 'tls',
  ],
  skipNodeModulesBundle: true,
});
