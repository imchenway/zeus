import { configDefaults, defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    passWithNoTests: false,
    // 真实代码扫描与图谱验证会读取当前仓库源码；在发布门禁并行运行时，Vitest 默认 5s 容易把真实 I/O 判成超时失败。
    testTimeout: 15_000,
    // Rust runtime 的可复现构建缓存包含上游 Jest 测试；它不是 Zeus test suite，也不能污染真实仓库扫描。
    exclude: [...configDefaults.exclude, '**/.tmp/**'],
  },
  resolve: {
    alias: {
      '@zeus/ai-runtime': resolve(__dirname, 'packages/ai-runtime/src/index.ts'),
      '@zeus/code-indexer': resolve(__dirname, 'packages/code-indexer/src/index.ts'),
      '@zeus/diagram-engine': resolve(__dirname, 'packages/diagram-engine/src/index.ts'),
      '@zeus/git-core': resolve(__dirname, 'packages/git-core/src/index.ts'),
      '@zeus/graph-engine': resolve(__dirname, 'packages/graph-engine/src/index.ts'),
      '@zeus/local-server': resolve(__dirname, 'packages/local-server/src/index.ts'),
      '@zeus/project-core': resolve(__dirname, 'packages/project-core/src/index.ts'),
      '@zeus/release-core': resolve(__dirname, 'packages/release-core/src/index.ts'),
      '@zeus/security-core': resolve(__dirname, 'packages/security-core/src/index.ts'),
      '@zeus/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@zeus/storage': resolve(__dirname, 'packages/storage/src/index.ts'),
      '@zeus/task-core': resolve(__dirname, 'packages/task-core/src/index.ts'),
      '@zeus/terminal-core': resolve(__dirname, 'packages/terminal-core/src/index.ts'),
      '@zeus/telegram-adapter': resolve(__dirname, 'packages/telegram-adapter/src/index.ts'),
    },
  },
});
