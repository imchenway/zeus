import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository-relative build inputs accompany the GPL combined application. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** electron-builder runs this common hook for both macOS and Windows packages. */
export default async function stageCorrespondingSource() {
  /** Keep source in the shared packaged dist tree, outside native platform resources. */
  const destination = join(root, 'apps/desktop/dist/licenses');
  await mkdir(destination, { recursive: true });
  /** Git selects project source, including new files, without copying ignored profiles or credentials. */
  const candidates = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 16 * 1024 * 1024 })
    .toString()
    .split('\0');
  /** Build and source roots exclude private task documents and generated artifacts. */
  const selected = [...new Set(candidates)].filter((name) => name && (/^(apps|packages|scripts|third_party|\.github)\//u.test(name) || !name.includes('/')) && !/(^|\/)(node_modules|dist|\.tmp|\.env(?:\.[^/]*)?)(\/|$)/u.test(name));
  /** A staged deletion is not an input; regular source files and symlinks are retained by tar. */
  const files = [];
  for (const name of selected) {
    if (
      await stat(join(root, name)).then(
        () => true,
        () => false,
      )
    )
      files.push(name);
  }
  /** NUL-separated names avoid shell expansion and preserve spaces on both platforms. */
  execFileSync('tar', ['-czf', join(destination, 'zeus-source.tar.gz'), '--null', '-T', '-'], {
    cwd: root,
    input: Buffer.from(files.sort().join('\0') + '\0'),
    maxBuffer: 4 * 1024 * 1024,
  });
  for (const name of ['NOTICE', 'COPYING', 'LICENSE']) await copyFile(join(root, name), join(destination, name));
  /** GitHub Copilot SDK 与随附 CLI 使用不同许可证，发行包分别提供两份原文。 */
  await copyFile(join(root, 'third_party/licenses/copilot-sdk/LICENSE'), join(destination, 'copilot-sdk-LICENSE'));
  await copyFile(join(root, 'third_party/licenses/copilot-cli/LICENSE.md'), join(destination, 'copilot-cli-LICENSE.md'));
}
