import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rendererChunkTargetBytes = 360 * 1024;

export default defineConfig(({ command }) => ({
  root: '.',
  // Electron 打包后通过 file:// 加载 index.html，必须使用相对资源路径，避免 /assets 指向磁盘根目录导致白屏。
  base: './',
  // 启动入口含一次性宿主初始化，不可作为 Fast Refresh 边界重复执行。
  plugins: [
    react(command === 'serve' ? { exclude: /\/src\/renderer\/main\.tsx$/ } : {}),
    {
      name: 'editor-runtime-singleton',
      handleHotUpdate({ file, server }) {
        // 编辑器模块引用 VS Code 单例服务；相关代码变更统一重新载入，避免热更新重复注册。
        if (/\/src\/renderer\/code\/.*\.(?:tsx?|json)$/.test(file)) {
          server.ws.send({ type: 'full-reload' });
          return [];
        }
      },
    },
  ],
  optimizeDeps: { exclude: ['monaco-editor', '@codingame/monaco-vscode-api'] },
  // Blob Worker 没有相对文件基址，其动态依赖也必须内联。
  worker: { format: 'es', rolldownOptions: { output: { codeSplitting: false } } },
  build: {
    assetsInlineLimit: 0,
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          maxSize: rendererChunkTargetBytes,
          groups: [
            {
              // 共享预加载辅助函数不能被大型编辑器包吸收，否则首屏会反向加载整个编辑器。
              name: 'vite-runtime',
              test: /\0vite[\\/]/u,
              priority: 110,
            },
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
              // VS Code 服务使用共享注册表并存在循环引用，保持同一运行时分块以保证初始化顺序。
              name: 'monaco-vscode-runtime',
              test: (id) => /node_modules[\\/]/u.test(id) && /(?:@codingame[\\/+]monaco-vscode|monaco-editor)/u.test(id),
              priority: 97,
              maxSize: 48 * 1024 * 1024,
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
              name: 'floating-ui-runtime',
              test: /node_modules[\\/]@floating-ui[\\/]/u,
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
              test: (id) => /node_modules[\\/]/u.test(id) && !/(?:@codingame[\\/+]|@shikijs[\\/+]|monaco-editor)/u.test(id),
              priority: 20,
            },
            {
              name: 'renderer-runtime',
              // 源码预览与高亮重模块必须保留为动态入口；renderer-runtime 若吞入它们，Vite 会重新在首屏预加载全部语法解析器。
              test: /src[\\/]renderer[\\/](?!code[\\/](?:CodeEditor|CodeDiffView|ConflictCodeEditor|SourceCodePreview|ProjectSourceEditor|sourceLanguageRegistry|monacoRuntime|monacoGrammars|monacoSourceDecorations|monacoConflictAlignment|sourceLanguageProviders)\.(?:ts|tsx)$)/u,
              priority: 10,
            },
          ],
        },
      },
    },
  },
}));
