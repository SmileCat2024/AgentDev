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
        'src/core/viewer-html.ts',
        'src/index.ts',
        'src/agents/index.ts',
        'src/cli/**',
        'src/types/**',
      ],
    },
  },
});
