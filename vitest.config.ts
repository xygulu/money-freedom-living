// 复制为项目根的 vitest.config.ts（去掉 .example 后缀）。
import path from 'node:path';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// vitest 不自动读 .env.local：显式加载，存储类用例（依赖 DATABASE_URL 等）
// 才能在本地默认执行（无库环境仍应在用例里 describe.skipIf 跳过）
Object.assign(process.env, loadEnv('test', process.cwd(), ''));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
