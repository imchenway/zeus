import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 凭据仅经 askpass 标准输出交给 Git；临时文件不包含用户输入。 */
export async function withProjectGitAuthentication<T>(operation: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  if (process.platform !== 'darwin') return operation({ GIT_TERMINAL_PROMPT: '0' });
  const directory = await mkdtemp(join(tmpdir(), 'zeus-git-auth-'));
  const helper = join(directory, 'askpass');
  try {
    await writeFile(helper, '#!/bin/sh\nexec /usr/bin/osascript "$0.applescript" "$@"\n', { mode: 0o700 });
    await writeFile(
      `${helper}.applescript`,
      `on run arguments
  if (count of arguments) is 0 then error number -128
  set promptText to item 1 of arguments
  if promptText contains "yes/no" then
    set resultDialog to display dialog promptText with title "Zeus · 核对 Git 服务器指纹" buttons {"取消", "信任此服务器"} default button "取消" cancel button "取消" giving up after 90
    if gave up of resultDialog then error number -128
    return "yes"
  else if promptText contains "Username" then
    set resultDialog to display dialog promptText with title "Zeus · Git 用户名" default answer "" buttons {"取消", "继续"} default button "继续" cancel button "取消" giving up after 90
  else
    set resultDialog to display dialog promptText with title "Zeus · Git 密码或密钥口令" default answer "" with hidden answer buttons {"取消", "继续"} default button "继续" cancel button "取消" giving up after 90
  end if
  if gave up of resultDialog then error number -128
  return text returned of resultDialog
end run
`,
      { mode: 0o600 },
    );
    return await operation({ GIT_ASKPASS: helper, SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0', GIT_TERMINAL_PROMPT: '0' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
