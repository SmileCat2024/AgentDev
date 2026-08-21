import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/__tests__/**/*.test.ts',
      'test/**/*.test.ts',
      'test/workthread/**/*.test.ts',
      'src/features/*/test/**/*.test.ts',
    ],
    exclude: [
      'node_modules',
      'dist',
    ],
    pool: 'forks',
    environment: 'node',
    setupFiles: ['test/setup.ts'],
  },
});
