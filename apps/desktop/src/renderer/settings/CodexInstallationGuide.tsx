import { useState } from 'react';
import type { AiRuntimeAdapterStatus } from '../features/runtime/runtimeContracts.js';
import { Button } from '../ui/Button.js';

/** 登录前的程序准备面，只展示检测事实和用户可主动执行的操作。 */
export function CodexInstallationGuide(props: {
  /** 当前页面语言。 */
  zh: boolean;
  /** 当前登录方式实际使用的程序检测结果。 */
  status: AiRuntimeAdapterStatus;
  /** 检测或认证期间暂停重复操作。 */
  busy: boolean;
  /** 首次安装或修复后重新检测同一受管程序。 */
  onCheck: () => Promise<void>;
  /** 打开官方安装说明。 */
  onOpenGuide: () => Promise<void>;
}) {
  /** 复制结果不混入账号登录错误。 */
  const [feedback, setFeedback] = useState<string | null>(null);
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
        ? 'Zeus 管理的 Codex 路径不可用'
        : 'The Zeus-managed Codex path is unavailable'
      : issue === 'cannot_run'
        ? props.zh
          ? '检测到 Codex，但程序无法运行'
          : 'Codex was found but could not run'
        : issue === 'unrecognized_program'
          ? props.zh
            ? 'Zeus 管理的 Codex 程序无法识别'
            : 'The Zeus-managed Codex program could not be identified'
          : issue === 'app_server_unavailable'
            ? props.zh
              ? '当前 Codex 缺少所需能力'
              : 'This Codex installation lacks a required capability'
            : props.zh
              ? 'Zeus 管理的 Codex 尚未就绪'
              : 'Zeus-managed Codex is not ready';

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
                ? '请检查 Zeus 专属目录中的程序和执行权限，再重新检测。'
                : 'Check the program and permissions in the Zeus directory, then detect again.'
              : issue === 'cannot_run'
                ? props.zh
                  ? '请检查安装是否完整、执行权限及所需的运行环境。修复后重新检测。'
                  : 'Check the installation, permissions and required runtime, then detect again.'
                : issue === 'unrecognized_program'
                  ? props.zh
                    ? '受管程序没有返回 Codex 版本信息，请使用下方命令修复。'
                    : 'The managed program did not return a Codex version. Repair it with the command below.'
                  : issue === 'app_server_unavailable'
                    ? props.zh
                      ? '当前程序未通过 app-server 能力检查，请更新或修复 Codex 后重新检测。'
                      : 'The app-server capability check failed. Update or repair Codex, then detect again.'
                    : props.zh
                      ? '请使用下方命令在 Zeus 专属目录准备程序，然后回到这里登录。'
                      : 'Prepare Codex in the Zeus directory with the command below, then return here to sign in.'}
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
            </div>
          ) : null}
        </>
      ) : null}
      {feedback ? <p role="status">{feedback}</p> : null}
    </section>
  );
}
