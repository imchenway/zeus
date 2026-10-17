import assert from 'node:assert/strict';
import console from 'node:console';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { openConversationResource, openTurnChangeFile } from '../apps/desktop/src/main/conversationResourceOpen.ts';

/** 本检查只核对 macOS 打开协议，不启动或控制外部编辑器。 */
assert.equal(process.platform, 'darwin');
/** 临时目录转为真实路径，与生产授权校验使用相同身份。 */
const root = await realpath(await mkdtemp(join(tmpdir(), 'zeus-editor-open-')));
/** 文件名覆盖空格、中文和 URL 特殊字符。 */
const path = join(root, '打开 文件 #检查.md');
/** 只记录生产入口实际发出的命令和参数。 */
const launches = [];
/** 编辑器名称、安装目录和内置命令与固定应用列表对应。 */
const editors = [
  ['vscode', 'Visual Studio Code', 'code'],
  ['vscode-insiders', 'Visual Studio Code - Insiders', 'code-insiders'],
  ['cursor', 'Cursor', 'cursor'],
  ['windsurf', 'Windsurf', 'windsurf'],
];
/** 模拟主机已检测到的安装文件，不访问真实用户应用。 */
const installed = new Set(editors.flatMap(([, name, cli]) => [`/Applications/${name}.app`, `/Applications/${name}.app/Contents/Resources/app/bin/${cli}`]));
/** 授权意图的文件身份保持固定，两个入口共用相同授权根。 */
const intent = { id: 'resource', projectId: 'project', conversationId: 'conversation', turnId: 'turn', itemId: 'item', kind: 'file', presentation: 'inline', display: {}, target: { absolutePath: path }, authority: { allowedRoot: root } };
/** 替换外部副作用，路径授权、定位校验和生产打开分支均照常执行。 */
const services = {
  config: { baseUrl: 'http://127.0.0.1', apiToken: 'check' },
  fetchJson: async (url) => ({ ...intent, id: url.includes('/change-set/') ? 'turn_change_file_open_file' : intent.id }),
  pathExists: async (candidate) => installed.has(candidate),
  applicationHome: root,
  executeFile: async (command, args) => {
    launches.push({ command, args });
  },
};
try {
  await writeFile(path, '# 完整文件\n第二行\n第三行\n');
  for (const [id, name, cli] of editors) {
    /** 每个固定编辑器分别核对整文件和行列定位，确保传递同一个真实路径。 */
    const request = { projectId: 'project', conversationId: 'conversation', resourceId: 'resource', target: `editor:${id}` };
    /** 命令必须属于用户选择的应用，不能退回只传启动参数的系统 open。 */
    const command = `/Applications/${name}.app/Contents/Resources/app/bin/${cli}`;
    await openConversationResource(request, services);
    assert.deepEqual(launches.at(-1), { command, args: [path] });
    await openTurnChangeFile({ ...request, turnId: 'turn', changeSetId: 'change', fileId: 'file', location: { line: 2, column: 3 } }, services);
    assert.deepEqual(launches.at(-1), { command, args: ['--goto', `${path}:2:3`] });
  }
  installed.delete('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code');
  await assert.rejects(openConversationResource({ projectId: 'project', conversationId: 'conversation', resourceId: 'resource', target: 'editor:vscode' }, services), { code: 'ZEUS_CONVERSATION_RESOURCE_TARGET_UNAVAILABLE' });
  assert.equal(launches.length, 8);
  console.log('PASS: 四个编辑器、两个打开入口、完整路径及行列参数正确；CLI 缺失时不执行打开。');
} finally {
  await rm(root, { recursive: true, force: true });
}
