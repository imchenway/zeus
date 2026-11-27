import { AppWindowIcon as AppWindow } from '@phosphor-icons/react/dist/csr/AppWindow';
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import type { ConversationResourceOpenTarget } from '@zeus/shared';
import { useEffect, useState } from 'react';
import { ZeusSelect } from '../ZeusSelect.js';
import { isMacOSPlatform } from '../platform.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { Button } from '../ui/Button.js';
import { useAsyncAction } from '../ui/useAsyncAction.js';

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
  /** 同一个项目的会话和工作树复用该项目上次使用的应用。 */
  const preferredApplicationKey = `zeus.working-directory.open-target:${encodeURIComponent(props.projectId)}`;
  /** 先恢复应用名和原生图标，等待本机应用列表时也能显示上次选择。 */
  const [preferred, setPreferred] = useState<ConversationResourceOpenTarget | null>(() => {
    try {
      /** 缺失或损坏的本机记录交给默认应用处理。 */
      const application = JSON.parse(window.localStorage.getItem(preferredApplicationKey) ?? 'null') as ConversationResourceOpenTarget | null;
      return typeof application?.id === 'string' && typeof application.label === 'string' ? application : null;
    } catch {
      return null;
    }
  });
  /** 空列表时可使用本机记录或系统文件管理器。 */
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

  /** 主按钮和下拉都在成功打开后更新项目记录。 */
  const { pending, execute: openDirectory } = useAsyncAction(async (application: ConversationResourceOpenTarget) => {
    setOpenError(null);
    try {
      await window.zeus!.openWorkingDirectory({ projectId: props.projectId, conversationId: props.conversationId, cwd: props.cwd, target: application.id });
    } catch (error) {
      setOpenError(error);
      return;
    }
    setPreferred(application);
    try {
      window.localStorage.setItem(preferredApplicationKey, JSON.stringify(application));
    } catch {
      // 本机存储不可写时，本次面板仍可使用所选应用。
    }
  });

  /** 用最新列表确认应用可用性，列表尚未取得时沿用本项目的记录。 */
  const selected = applications.find((application) => application.id === preferred?.id) ?? (applications.length === 0 ? preferred : applications[0]) ?? systemFileManager();
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
          onClick={() => openDirectory(selected)}
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
            onChange={(target) => {
              /** 应用列表同时提供打开目标和下次显示所需的名称与图标。 */
              const application = applications.find((option) => option.id === target);
              if (application) openDirectory(application);
            }}
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
