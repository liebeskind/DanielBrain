import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/__tests__/**/*.test.ts'],
    exclude: ['packages/**/__tests__/**/integration/**'],
    testTimeout: 10000,
  },
});
