#!/usr/bin/env node
import {rmSync} from 'node:fs';
import {resolve} from 'node:path';

const desktopRoot = resolve(import.meta.dirname, '..');

// TypeScript 不会删除已移除源码留下的旧文件；打包前只清理三个受控构建目录，避免废弃模块进入 app.asar。
for (const directory of ['dist/main', 'dist/preload', 'dist/renderer']) {
    rmSync(resolve(desktopRoot, directory), {recursive: true, force: true});
}
