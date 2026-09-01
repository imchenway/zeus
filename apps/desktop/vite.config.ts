import {defineConfig} from 'vite';
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
                // 会话正文与文件预览共用同一 Markdown 运行时，保持其内部模块在同一代码包中。
              name: 'markdown-runtime',
                test: /node_modules[\\/](?:markstream-react|markstream-core|stream-markdown-parser|markdown-it(?:-[^\\/]+)?|linkify-it|mdurl|uc\.micro|entities|punycode\.js|@floating-ui[\\/][^\\/]+|clsx)[\\/]/u,
              priority: 95,
              maxSize: 2 * 1024 * 1024,
            },
            {
              // CodeMirror 与 Lezer 存在双向运行时引用，必须保持同一分块，避免体积拆分后构造器尚未初始化。
              name: 'code-editor-runtime',
              test: /node_modules[\\/](?:codemirror|@codemirror[\\/][^/]+|@lezer[\\/][^/]+|crelt|style-mod|w3c-keyname)[\\/]/u,
              priority: 96,
              // maxSize 依据压缩前模块体积切分；2 MiB 会把最终约 1.1 MiB 的运行时拆成循环依赖分块。
              // 提高内部切分阈值后，产物仍低于仓库 2 MiB 的实际单文件门禁，同时保证构造器初始化顺序。
              maxSize: 8 * 1024 * 1024,
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
              // 三个高亮重模块必须保留为动态入口；renderer-runtime 若吞入它们，Vite 会重新在首屏预加载全部语法解析器。
              test: /src[\\/]renderer[\\/](?!code[\\/](?:CodeEditor|sourceLanguageRegistry|syntaxHighlightRuntime)\.(?:ts|tsx)$)/u,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
