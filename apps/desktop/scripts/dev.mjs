import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const desktop = resolve(root, 'apps/desktop');
const mode = process.env.ZEUS_DEV_MODE || 'development';
if (!['development', 'test'].includes(mode)) {
  throw new Error('开发入口仅支持 development/test；正式应用继续使用原有构建发布入口。');
}
// 仅开发入口读取配置，系统环境变量优先；不改变构建与发布的环境加载规则。
const configured = {};
for (const name of ['.env', `.env.${mode}`]) {
  try {
    Object.assign(configured, parseEnv(await readFile(resolve(root, name), 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const env = { ...configured, ...process.env };
delete env.ZEUS_RELEASE_BUILD;
delete env.ZEUS_PACKAGE_VARIANT;
env.ZEUS_USER_DATA_DIR ||= resolve(root, `.tmp/electron-${mode}-data`);

let child;
let server;
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  // 只终止本次启动的进程组，不匹配或终止已安装的 Zeus。
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') console.error(error);
    }
  }
  await server?.close();
  process.exitCode = code;
}
process.on('SIGINT', () => void stop(130));
process.on('SIGTERM', () => void stop(143));

function run(command, args, environment) {
  return new Promise((resolveExit, reject) => {
    child = spawn(command, args, { cwd: root, env: environment, stdio: 'inherit', detached: true });
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}

try {
  // 首次准备主进程、preload 和本地辅助程序；后续前端编辑不再执行构建。
  const code = await run('pnpm', ['build'], env);
  if (code !== 0 || stopping) {
    await stop(code);
  } else {
    server = await createServer({
      root: desktop,
      mode,
      envDir: root,
      plugins: [
        {
          name: 'zeus-dev-refresh-csp',
          // React Refresh 注入内联前导脚本；仅开发服务放行，生产 HTML 保持严格策略。
          transformIndexHtml: {
            order: 'post',
            handler: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
          },
        },
      ],
      server: { host: '127.0.0.1', port: 0, open: false },
    });
    await server.listen();
    const url = server.resolvedUrls.local[0];
    console.log(`Zeus 开发模式：${url}（前端热更新；主进程/preload 修改后重启 pnpm dev）`);
    const exitCode = await run('bash', ['script/build_and_run.sh', process.argv[2] || 'run'], {
      ...env,
      ZEUS_DEV_SERVER_READY: '1',
      ZEUS_DEV_SERVER_URL: url,
    });
    await stop(exitCode);
  }
} catch (error) {
  console.error(error);
  await stop(1);
}
