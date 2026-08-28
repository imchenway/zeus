import { useEffect, useRef } from 'react';
import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { SpinnerGapIcon as SpinnerGap } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import type { ReleaseUpdateStatusSnapshot } from '../apiClient.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';

export type ReleaseUpdateDialogState =
  | { kind: 'checking' }
  | { kind: 'result'; update: ReleaseUpdateStatusSnapshot }
  | { kind: 'installing'; update: ReleaseUpdateStatusSnapshot }
  | { kind: 'failed'; update?: ReleaseUpdateStatusSnapshot; reason?: string };

export interface ReleaseUpdateDialogProps {
  language: 'zh-CN' | 'en';
  state: ReleaseUpdateDialogState;
  onDismiss: () => void;
  onRetry: () => void;
  onOpenDownloadPage: (update: ReleaseUpdateStatusSnapshot) => void;
  onInstall: (update: ReleaseUpdateStatusSnapshot) => void;
}

const copyByLanguage = {
  'zh-CN': {
    checkingTitle: '正在检查更新',
    checkingDescription: 'Zeus 正在读取 GitHub Release 的真实发布清单。',
    currentTitle: 'Zeus 已是最新版本',
    availableTitle: '发现新版本',
    unavailableTitle: '暂时无法检查更新',
    failedTitle: '更新操作未能开始',
    installingTitle: '正在准备升级',
    currentVersion: (version: string) => `当前版本 ${version}`,
    latestVersion: (version: string) => `最新版本 ${version}`,
    currentDescription: '当前安装版本不低于发布清单中的最新版本。',
    manualDescription: '该版本尚未同时完成签名和公证。Zeus 不会自动替换应用，你可以前往发布页手动升级。',
    installDescription: '发布产物已经签名并公证，可以下载并进入安装流程。',
    unavailableDescription: 'Zeus 没有取得可用的发布清单。请检查网络连接后重试。',
    installingDescription: '升级请求已经提交。安装流程完成后 Zeus 会提示重启。',
    artifact: (fileName: string) => `安装包：${fileName}`,
    detachedHost: '执行宿主已独立运行',
    embeddedHost: '执行仍绑定当前界面进程',
    hostWork: (turns: number, requests: number, runtimes: number) => `执行中 ${turns} · 等待交互 ${requests} · 其他 Runtime ${runtimes}`,
    runtimeGenerations: (count: number, draining: number) => `Codex 运行时世代 ${count} · 排空中 ${draining}`,
    detachedHostDescription: '安装完成后的完整重启会先停止这些工作，再关闭旧版 Core 并启动新版。',
    embeddedHostDescription: '当前构建退出时仍可能结束执行，不能宣称无损升级。',
    cancel: '取消',
    later: '稍后',
    done: '好',
    retry: '重新检查',
    openDownloadPage: '打开下载页',
    install: '下载并安装',
  },
  en: {
    checkingTitle: 'Checking for updates',
    checkingDescription: 'Zeus is reading the real GitHub Release manifest.',
    currentTitle: 'Zeus is up to date',
    availableTitle: 'A new version is available',
    unavailableTitle: 'Unable to check for updates',
    failedTitle: 'The update could not start',
    installingTitle: 'Preparing the update',
    currentVersion: (version: string) => `Current version ${version}`,
    latestVersion: (version: string) => `Latest version ${version}`,
    currentDescription: 'The installed version is already at or above the latest release manifest version.',
    manualDescription: 'This release is not both signed and notarized. Zeus will not replace the app automatically; you can upgrade from the release page.',
    installDescription: 'The release is signed and notarized and can enter the download and installation flow.',
    unavailableDescription: 'Zeus did not receive a usable release manifest. Check the network connection and try again.',
    installingDescription: 'The update request was accepted. Zeus will prompt for a restart when installation is ready.',
    artifact: (fileName: string) => `Installer: ${fileName}`,
    detachedHost: 'Execution host is detached',
    embeddedHost: 'Execution is still owned by this UI process',
    hostWork: (turns: number, requests: number, runtimes: number) => `${turns} running · ${requests} awaiting input · ${runtimes} other runtimes`,
    runtimeGenerations: (count: number, draining: number) => `${count} Codex runtime generations · ${draining} draining`,
    detachedHostDescription: 'The full restart after installation stops this work, closes the previous Core, and then starts the new version.',
    embeddedHostDescription: 'This build may still stop execution on exit and cannot claim lossless upgrades.',
    cancel: 'Cancel',
    later: 'Later',
    done: 'OK',
    retry: 'Check Again',
    openDownloadPage: 'Open Download Page',
    install: 'Download and Install',
  },
} as const;

export function ReleaseUpdateDialog(props: ReleaseUpdateDialogProps) {
  const copy = copyByLanguage[props.language];
  const primaryActionRef = useRef<HTMLButtonElement>(null);
  const update = props.state.kind === 'checking' ? undefined : props.state.update;
  const checking = props.state.kind === 'checking';
  const installing = props.state.kind === 'installing';
  const busy = checking || installing;
  const unavailable = props.state.kind === 'result' && update?.status === 'unavailable';
  const failed = props.state.kind === 'failed';
  const upToDate = props.state.kind === 'result' && update?.status === 'up_to_date';
  const available = props.state.kind === 'result' && update?.status === 'available';

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => primaryActionRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [props.state.kind, update?.status, update?.latestVersion]);

  if (failed || unavailable) {
    const error = props.state.kind === 'failed' ? props.state.reason?.trim() || copy.failedTitle : update?.reason?.trim() || copy.unavailableTitle;
    return (
      <ModalPortal rootClassName="release-update-dialog-portal-root" backdropClassName="release-update-dialog-backdrop" onDismiss={props.onDismiss}>
        <section className="release-update-dialog zeus-solid-form-surface" role="alertdialog" aria-modal="true" aria-label={copy.failedTitle} data-state="failed">
          <div className="release-update-dialog-content">
            <VisibleApplicationError error={error} language={props.language} />
          </div>
          <footer>
            <Button variant="secondary" size="regular" onClick={props.onDismiss}>
              {copy.cancel}
            </Button>
            <Button ref={primaryActionRef} variant="primary" size="regular" onClick={props.onRetry}>
              {copy.retry}
            </Button>
          </footer>
        </section>
      </ModalPortal>
    );
  }

  let title: string = copy.checkingTitle;
  let description: string = copy.checkingDescription;
  if (props.state.kind === 'installing') {
    title = copy.installingTitle;
    description = copy.installingDescription;
  } else if (upToDate) {
    title = copy.currentTitle;
    description = copy.currentDescription;
  } else if (unavailable) {
    title = copy.unavailableTitle;
    description = copy.unavailableDescription;
  } else if (available && update) {
    title = copy.availableTitle;
    description = update.automaticInstallEnabled ? copy.installDescription : copy.manualDescription;
  }

  return (
    <ModalPortal rootClassName="release-update-dialog-portal-root" backdropClassName="release-update-dialog-backdrop" dismissDisabled={installing} onDismiss={props.onDismiss}>
      <section className="release-update-dialog zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="release-update-dialog-title" aria-describedby="release-update-dialog-description" data-state={props.state.kind}>
        <div className="release-update-dialog-icon" data-tone={upToDate ? 'success' : 'progress'} aria-hidden="true">
          {busy ? <SpinnerGap className="release-update-dialog-spinner" weight="regular" /> : upToDate ? <CheckCircle weight="regular" /> : <ArrowSquareOut weight="regular" />}
        </div>
        <div className="release-update-dialog-content">
          <header>
            <strong id="release-update-dialog-title">{title}</strong>
            <p id="release-update-dialog-description" role="status">
              {description}
            </p>
          </header>
          {update ? (
            <>
              <div className="release-update-dialog-version" aria-label={title}>
                <span>{copy.currentVersion(update.currentVersion)}</span>
                <span>{copy.latestVersion(update.latestVersion)}</span>
                {update.artifact ? <small>{copy.artifact(update.artifact.fileName)}</small> : null}
              </div>
              {update.executionHost ? (
                <div className="release-update-dialog-host" data-mode={update.executionHost.mode}>
                  <strong>{update.executionHost.mode === 'detached' ? copy.detachedHost : copy.embeddedHost}</strong>
                  <span>{copy.hostWork(update.executionHost.activeTurnCount, update.executionHost.waitingRequestCount, update.executionHost.activeRuntimeCount)}</span>
                  {update.executionHost.runtimeGenerations.length > 0 ? (
                    <span>{copy.runtimeGenerations(update.executionHost.runtimeGenerations.length, update.executionHost.runtimeGenerations.filter((generation) => !generation.active).length)}</span>
                  ) : null}
                  <small>{update.executionHost.mode === 'detached' ? copy.detachedHostDescription : copy.embeddedHostDescription}</small>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <footer>
          {checking ? (
            <Button ref={primaryActionRef} variant="secondary" size="regular" onClick={props.onDismiss}>
              {copy.cancel}
            </Button>
          ) : installing ? (
            <Button variant="secondary" size="regular" onClick={props.onDismiss} disabled>
              {copy.cancel}
            </Button>
          ) : upToDate ? (
            <Button ref={primaryActionRef} variant="primary" size="regular" onClick={props.onDismiss}>
              {copy.done}
            </Button>
          ) : available && update ? (
            <>
              <Button variant="secondary" size="regular" onClick={props.onDismiss}>
                {copy.later}
              </Button>
              {update.recommendedAction === 'download_and_install' ? (
                <Button ref={primaryActionRef} variant="primary" size="regular" onClick={() => props.onInstall(update)}>
                  {copy.install}
                </Button>
              ) : (
                <Button ref={primaryActionRef} variant="primary" size="regular" onClick={() => props.onOpenDownloadPage(update)}>
                  {copy.openDownloadPage}
                </Button>
              )}
            </>
          ) : (
            <Button ref={primaryActionRef} variant="primary" size="regular" onClick={props.onDismiss}>
              {copy.done}
            </Button>
          )}
        </footer>
      </section>
    </ModalPortal>
  );
}
