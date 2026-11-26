import { AppWindowIcon as AppWindow } from '@phosphor-icons/react/dist/csr/AppWindow';
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import type { ConversationOpenTarget, ConversationResourceOpenTarget } from '@zeus/shared';
import { useEffect, useState } from 'react';
import { ZeusSelect } from '../ZeusSelect.js';
import { isMacOSPlatform } from '../platform.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { Button } from '../ui/Button.js';
import { useAsyncAction } from '../ui/useAsyncAction.js';

/** 只保存用户用于打开工作目录的应用身份。 */
const preferredApplicationKey = 'zeus.working-directory.open-target';

/** 工作目录始终可以交给本机文件管理器，无需等候编辑器检测。 */
function systemFileManager(): ConversationResourceOpenTarget {
  return { id: 'file_manager', label: isMacOSPlatform() ? 'Finder' : 'File Explorer', available: true, exactLocation: false };
}

/** 两个入口同用应用名，长品牌名在环境行内保留常用简称。 */
function applicationLabel(target: ConversationResourceOpenTarget, zh: boolean): string {
  if (target.id === 'editor:vscode') return 'VS Code';
  return zh && target.id === 'file_manager' && !isMacOSPlatform() ? '文件资源管理器' : target.label;
}

/** 目录按钮和列表都优先显示本机应用图标。 */
function applicationIcon(target: ConversationResourceOpenTarget) {
  if (target.iconDataUrl) return <img src={target.iconDataUrl} alt="" width={17} height={17} />;
  return target.id === 'file_manager' ? <FolderOpen aria-hidden="true" /> : <AppWindow aria-hidden="true" />;
}

/** 主按钮打开当前工作目录，下拉选择用于此次及后续打开的应用。 */
export function SessionWorkingDirectoryLauncher(props: { projectId: string; conversationId: string; cwd: string; visible: boolean; zh: boolean }) {
  /** 目录和会话切换时重新读取本机偏好，应用退出后偏好仍可复用。 */
  const [preferred, setPreferred] = useState(() => {
    try {
      return window.localStorage.getItem(preferredApplicationKey);
    } catch {
      return null;
    }
  });
  /** 空列表表示仍可通过系统文件管理器打开。 */
  const [applications, setApplications] = useState<ConversationResourceOpenTarget[]>([]);
  /** 探测失败只影响编辑器选项。 */
  const [discoveryError, setDiscoveryError] = useState<unknown>(null);
  /** 打开失败归属当前目录，下一次操作清除原来的反馈。 */
  const [openError, setOpenError] = useState<unknown>(null);

  useEffect(() => {
    if (!props.visible || !window.zeus?.listWorkingDirectoryOpenTargets) return;
    /** 退场或换会话后的结果不再更新当前面板。 */
    let visible = true;
    setDiscoveryError(null);
    void window.zeus.listWorkingDirectoryOpenTargets().then(
      (targets) => {
        if (visible) setApplications(targets);
      },
      (error: unknown) => {
        if (!visible) return;
        setApplications([]);
        setDiscoveryError(error);
      },
    );
    return () => {
      visible = false;
    };
  }, [props.visible]);

  /** 从下拉成功打开后更新偏好，临时兜底打开保留原偏好。 */
  const { pending, execute: openDirectory } = useAsyncAction(async (target: ConversationOpenTarget, remember: boolean) => {
    setOpenError(null);
    try {
      await window.zeus!.openWorkingDirectory({ projectId: props.projectId, conversationId: props.conversationId, cwd: props.cwd, target });
    } catch (error) {
      setOpenError(error);
      return;
    }
    if (!remember) return;
    setPreferred(target);
    try {
      window.localStorage.setItem(preferredApplicationKey, target);
    } catch {
      // 本机存储不可写时，本次面板仍可使用所选应用。
    }
  });

  /** 首选应用未安装时采用宿主返回的第一个可用应用。 */
  const selected = applications.find((application) => application.id === preferred) ?? applications[0] ?? systemFileManager();
  /** 主按钮的可见文字和读屏名称指向同一个应用。 */
  const selectedLabel = applicationLabel(selected, props.zh);
  const openLabel = props.zh ? `在 ${selectedLabel} 中打开` : `Open in ${selectedLabel}`;
  /** 下拉按钮只有图标，提示和读屏名称提供具体操作。 */
  const chooseLabel = props.zh ? '选择打开工作目录的应用' : 'Choose an app for the working directory';
  /** 点击失败优先于后台探测问题。 */
  const error = openError ?? discoveryError;

  return (
    <div>
      <div className="session-working-directory-launcher">
        <Button
          unstyled
          type="button"
          className="session-quick-actions-row session-working-directory-open"
          data-busy-behavior="background"
          aria-busy={pending || undefined}
          aria-disabled={pending || undefined}
          aria-label={props.zh ? `在 ${selectedLabel} 中打开工作目录` : `Open working directory in ${selectedLabel}`}
          data-icon-tooltip={openLabel}
          onClick={() => openDirectory(selected.id, false)}
        >
          <span className="session-working-directory-app-icon">{applicationIcon(selected)}</span>
          <span className="session-quick-actions-copy">
            <strong>{pending ? (props.zh ? '正在打开…' : 'Opening…') : openLabel}</strong>
          </span>
        </Button>
        {props.visible && applications.length > 1 ? (
          <ZeusSelect
            size="compact"
            className="session-working-directory-apps"
            popoverClassName="session-working-directory-apps-popover"
            popoverBoundarySelector=".session-quick-actions-card"
            popoverArrowAlignment="end"
            popoverMinWidth={240}
            ariaLabel={chooseLabel}
            triggerTooltip={chooseLabel}
            hideSelectedLabel
            searchable={false}
            value={selected.id}
            options={applications.map((application) => ({
              value: application.id,
              label: applicationLabel(application, props.zh),
              icon: applicationIcon(application),
            }))}
            onChange={(target) => openDirectory(target, true)}
          />
        ) : null}
      </div>
      {error ? (
        <div className="session-quick-actions-error" role="alert">
          <VisibleApplicationError error={error} language={props.zh ? 'zh-CN' : 'en'} summary={openError ? undefined : props.zh ? '无法读取已安装的编辑器。' : 'Could not detect installed editors.'} />
        </div>
      ) : null}
    </div>
  );
}
