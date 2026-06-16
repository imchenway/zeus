import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: '.',
  // Electron 打包后通过 file:// 加载 index.html，必须使用相对资源路径，避免 /assets 指向磁盘根目录导致白屏。
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
});
