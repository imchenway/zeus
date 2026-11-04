import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.tmp/**', '**/*.d.ts'] },
  js.configs.recommended,
  {
    // 既有脚本的 global 注释可重复声明宿主内置对象；代码中的重复声明仍报错。
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    rules: { 'no-redeclare': ['error', { builtinGlobals: false }] },
  },
  // TypeScript 专属规则只处理 TypeScript，JavaScript 使用上面的标准规则。
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'] })),
  {
    // Node.js 构建、发布和运维脚本使用宿主提供的全局对象。
    files: ['**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // 网页翻译运行于浏览器文档内，不具有 Node.js 全局对象。
    files: ['packages/browser-translation/src/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
];
