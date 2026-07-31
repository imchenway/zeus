import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rendererChunkTargetBytes = 360 * 1024;

export default defineConfig({
  root: '.',
  // Electron 打包后通过 file:// 加载 index.html，必须使用相对资源路径，避免 /assets 指向磁盘根目录导致白屏。
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          maxSize: rendererChunkTargetBytes,
          groups: [
            {
              name: 'react-runtime',
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/u,
              priority: 100,
            },
            {
              name: 'motion-runtime',
              test: /node_modules[\\/](?:framer-motion|motion-dom|motion-utils)[\\/]/u,
              priority: 90,
            },
            {
              name: 'icon-runtime',
              test: /node_modules[\\/]@phosphor-icons[\\/]react[\\/]/u,
              priority: 80,
            },
            {
              name: 'session-workspace',
              test: /src[\\/]renderer[\\/]session[\\/]/u,
              priority: 60,
            },
            {
              name: 'task-workspace',
              test: /src[\\/]renderer[\\/]task[\\/]/u,
              priority: 50,
            },
            {
              name: 'settings-workspace',
              test: /src[\\/]renderer[\\/](?:settings|release)[\\/]/u,
              priority: 40,
            },
            {
              name: 'vendor-runtime',
              test: /node_modules[\\/]/u,
              priority: 20,
            },
            {
              name: 'renderer-runtime',
              test: /src[\\/]renderer[\\/]/u,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
