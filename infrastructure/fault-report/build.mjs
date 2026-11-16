import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** 使用仓库已安装的 esbuild，产物无需安装任何云端依赖。 */
const require = createRequire(import.meta.url);
/** tsx 已固定依赖 esbuild，沿用锁文件中的版本。 */
const { build } = createRequire(require.resolve('tsx'))('esbuild');
await build({ entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))], bundle: true, platform: 'node', target: 'node20', format: 'esm', outfile: fileURLToPath(new URL('./dist/index.mjs', import.meta.url)) });
