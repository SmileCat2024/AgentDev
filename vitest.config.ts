import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/test/**/*.test.ts',
      'src/features/*/test/**/*.test.ts',
    ],
    exclude: [
      'src/test/test-runner.ts',
      'src/test/setup.ts',
      'node_modules',
      'dist',
    ],
    pool: 'forks',
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/test/**',
        'src/features/*/test/**',
        'src/**/__tests__/**',
        'src/core/viewer-html.ts',
        'src/index.ts',
        'src/agents/index.ts',
        'src/cli/**',
        'src/types/**',
      ],
      thresholds: {
        // baseline (2026-07-24): lines 37.05%, functions 31.54%, statements 36.35%
        // 设实测值以下 2% 作为安全余量，branches 暂不设门槛
        lines: 35,
        functions: 29,
        statements: 34,
      },
    },
  },
});
