import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/**/*.test.ts',
      'src/feature/test/**/*.test.ts',
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
