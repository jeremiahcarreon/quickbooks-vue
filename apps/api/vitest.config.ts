import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Test files share one Redis; run them one at a time.
    fileParallelism: false,
  },
});
