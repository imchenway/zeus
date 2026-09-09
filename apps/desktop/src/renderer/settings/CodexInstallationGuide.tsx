import { useId, useState } from 'react';
import type { AiRuntimeAdapterStatus } from '../features/runtime/runtimeContracts.js';
import { Button } from '../ui/Button.js';

/** 登录前的程序准备面，只展示检测事实和用户可主动执行的操作。 */
export function CodexInstallationGuide(props: {
  /** 当前页面语言。 */
  zh: boolean;
  /** 当前登录方式实际使用的程序检测结果。 */
  status: AiRuntimeAdapterStatus;
  /** 检测、保存或认证期间暂停重复操作。 */
  busy: boolean;
  /** 用户装好后重新读取程序和终端环境。 */
  onCheck: () => Promise<void>;
  /** 只保存程序路径，不保存账号或启动登录。 */
  onSavePath: (path: string) => Promise<void>;
  /** 打开官方安装说明。 */
  onOpenGuide: () => Promise<void>;
}) {
  /** 输入标签在多个任务引导同时存在时仍保持唯一。 */
  const pathId = useId();
  /** 手动路径属于当前检测结果，父层按检测时间更新此面。 */
  const [path, setPath] = useState(props.status.installation?.configuredCommandPath ?? '');
  /** 路径编辑保持为次要入口，首次安装只展示必要步骤。 */
  const [editingPath, setEditingPath] = useState(false);
  /** 复制及输入校验提示不混入账号登录错误。 */
  const [feedback, setFeedback] = useState<string | null>(null);
  /** 远程接管必须使用其专属安装目标。 */
  const remote = props.status.installation?.mode === 'remote';
  /** 安装命令由服务端按实际目标生成，组件不拼接用户路径。 */
  const command = props.status.installation?.command;
  /** 只使用结构化检测原因，不从错误文案猜测安装状态。 */
  const issue = props.status.installationIssue;
  /** 检测成功只表示程序准备完成，账号仍需另行认证。 */
  const title = props.status.available
    ? props.zh
      ? 'Codex 程序已就绪'
      : 'Codex is ready'
    : issue === 'invalid_path'
      ? props.zh
        ? '指定的 Codex 路径不可用'
        : 'The selected Codex path is unavailable'
      : issue === 'cannot_run'
        ? props.zh
          ? '检测到 Codex，但程序无法运行'
          : 'Codex was found but could not run'
        : issue === 'unrecognized_program'
          ? props.zh
            ? '无法确认所选程序是 Codex'
            : 'The selected program could not be identified as Codex'
          : issue === 'app_server_unavailable'
            ? props.zh
              ? '当前 Codex 缺少所需能力'
              : 'This Codex installation lacks a required capability'
            : props.zh
              ? '尚未检测到 Codex'
              : 'Codex has not been detected';

  /** 仅在用户点击时写入剪贴板，不执行安装脚本。 */
  async function copyCommand(): Promise<void> {
    if (!command) return;
    try {
      /** 优先使用桌面桥接，以免系统剪贴板权限影响正常复制。 */
      const result = await window.zeus?.writeClipboardText?.(command);
      if (!result?.written) await navigator.clipboard.writeText(command);
      setFeedback(props.zh ? '安装命令已复制，请在终端运行。' : 'Installation command copied. Run it in your terminal.');
    } catch {
      setFeedback(props.zh ? '未能复制，请手动选择下方命令。' : 'Could not copy. Select the command below manually.');
    }
  }

  /** 程序路径是文件位置，不能把整条终端命令作为路径保存。 */
  function savePath(): void {
    /** 空值恢复自动检测，路径格式沿用当前桌面设置的绝对路径约束。 */
    const candidate = path.trim();
    if (candidate && !candidate.startsWith('/')) {
      setFeedback(props.zh ? '请输入程序的完整绝对路径；留空可恢复自动检测。' : 'Enter the full absolute path, or leave it empty to detect automatically.');
      return;
    }
    setFeedback(null);
    void props.onSavePath(candidate);
  }

  return (
    <section className="model-setup-installation" aria-label={props.zh ? 'Codex 程序准备' : 'Codex installation'}>
      <div className="model-setup-installation-heading" role="status">
        <strong>{title}</strong>
        {props.status.version ? <span>{props.status.version}</span> : null}
      </div>
      {props.status.resolvedCommandPath ? <code className="model-setup-installation-path">{props.status.resolvedCommandPath}</code> : null}
      {!props.status.available ? (
        <>
          <p>
            {issue === 'invalid_path'
              ? props.zh
                ? '请确认程序位置和执行权限，也可以改用自动检测。'
                : 'Check the program location and permissions, or use automatic detection.'
              : issue === 'cannot_run'
                ? props.zh
                  ? '请检查安装是否完整、执行权限及所需的运行环境。修复后重新检测。'
                  : 'Check the installation, permissions and required runtime, then detect again.'
                : issue === 'unrecognized_program'
                  ? props.zh
                    ? '所选程序没有返回 Codex 版本信息。请检查程序路径，或按官方指南安装。'
                    : 'The program did not return a Codex version. Check the path or follow the official installation guide.'
                  : issue === 'app_server_unavailable'
                    ? props.zh
                      ? '当前程序未通过 app-server 能力检查，请更新或修复 Codex 后重新检测。'
                      : 'The app-server capability check failed. Update or repair Codex, then detect again.'
                    : remote
                      ? props.zh
                        ? '远程接管需要在 Zeus 专属目录准备 Codex。请使用下方安装命令。'
                        : 'Remote control needs a Codex installation in the Zeus directory. Use the command below.'
                      : props.zh
                        ? '使用订阅前需要安装 Codex。安装完成后回到这里，继续在 Zeus 内登录。'
                        : 'Install Codex to use your subscription, then return here to sign in within Zeus.'}
          </p>
          <div className="model-setup-actions">
            <Button variant="primary" disabled={props.busy} onClick={() => void props.onCheck()}>
              {props.zh ? '我已装好，重新检测' : 'Installed — check again'}
            </Button>
            <Button variant="secondary" disabled={props.busy} onClick={() => void props.onOpenGuide()}>
              {props.zh ? '查看官方安装指南' : 'Official installation guide'}
            </Button>
          </div>
          {command ? (
            <div className="model-setup-installation-command">
              <div className="model-setup-actions">
                <strong>{props.zh ? '在终端运行安装命令' : 'Run this command in your terminal'}</strong>
                <Button variant="secondary" size="compact" disabled={props.busy} onClick={() => void copyCommand()}>
                  {props.zh ? '复制安装命令' : 'Copy command'}
                </Button>
              </div>
              <pre>
                <code>{command}</code>
              </pre>
              <small>{props.zh ? '这里只安装程序。安装后请回到 Zeus 登录订阅。' : 'This installs the program. Return to Zeus to sign in afterward.'}</small>
            </div>
          ) : null}
        </>
      ) : null}
      {!remote ? (
        <div className="model-setup-installation-path-editor">
          <Button variant="secondary" size="compact" disabled={props.busy} aria-expanded={editingPath} aria-controls={`${pathId}-editor`} onClick={() => setEditingPath((value) => !value)}>
            {props.zh ? '手动指定程序路径' : 'Set the program path'}
          </Button>
          {editingPath ? (
            <form
              id={`${pathId}-editor`}
              onSubmit={(event) => {
                event.preventDefault();
                savePath();
              }}
            >
              <label htmlFor={pathId}>{props.zh ? 'Codex 程序的完整路径' : 'Full path to Codex'}</label>
              <input id={pathId} value={path} onChange={(event) => setPath(event.target.value)} disabled={props.busy} placeholder="/opt/homebrew/bin/codex" autoComplete="off" spellCheck={false} maxLength={256} />
              <small>{props.zh ? '留空可恢复自动检测。此设置只决定 Zeus 使用的程序。' : 'Leave empty to detect automatically. This only selects the program Zeus uses.'}</small>
              <div className="model-setup-actions">
                <Button type="submit" variant="primary" disabled={props.busy}>
                  {props.zh ? '保存并重新检测' : 'Save and check again'}
                </Button>
                <Button variant="secondary" disabled={props.busy} onClick={() => void props.onSavePath('')}>
                  {props.zh ? '使用自动检测' : 'Detect automatically'}
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
      {feedback ? <p role="status">{feedback}</p> : null}
    </section>
  );
}
