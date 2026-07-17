#!/usr/bin/env node
import { build } from 'vite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// sandbox: true 的 Electron preload 只能加载受限内建模块，项目内相对依赖必须内联进单文件。
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    lib: {
      entry: join(desktopDir, 'src', 'preload', 'index.cts'),
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    outDir: join(desktopDir, 'dist', 'preload'),
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      external: ['electron'],
      output: { exports: 'auto' },
    },
  },
});
