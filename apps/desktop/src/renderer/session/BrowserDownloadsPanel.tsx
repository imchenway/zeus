import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { PauseIcon as Pause } from '@phosphor-icons/react/dist/csr/Pause';
import { PlayIcon as Play } from '@phosphor-icons/react/dist/csr/Play';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { useLayoutEffect, useRef } from 'react';
import type { ZeusBrowserCommand, ZeusBrowserDownload } from '@zeus/shared';
import { FileTypeIcon } from '../code/FileTypeIcon.js';
import { Button } from '../ui/Button.js';

/** 下载列表的状态和操作文案随桌面语言显示。 */
const labelsByLanguage = {
  'zh-CN': {
    title: '下载',
    empty: '没有下载记录',
    close: '关闭下载列表',
    downloading: '正在下载',
    paused: '已暂停',
    interrupted: '已中断',
    completed: '已完成',
    cancelled: '已取消',
    failed: '下载失败',
    pause: '暂停',
    resume: '继续',
    cancel: '取消下载',
    reveal: '在文件夹中显示',
  },
  'en-US': {
    title: 'Downloads',
    empty: 'No downloads',
    close: 'Close downloads',
    downloading: 'Downloading',
    paused: 'Paused',
    interrupted: 'Interrupted',
    completed: 'Completed',
    cancelled: 'Cancelled',
    failed: 'Download failed',
    pause: 'Pause',
    resume: 'Resume',
    cancel: 'Cancel download',
    reveal: 'Show in folder',
  },
} as const;

/** 面板操作复用当前浏览器命令入口。 */
type DownloadCommand = Extract<ZeusBrowserCommand, { action: 'download' }>;

/** 下载面板占用实际布局空间，原生网页可继续操作。 */
export function BrowserDownloadsPanel({
  id,
  language,
  downloads,
  onClose,
  onCommand,
}: {
  id: string;
  language: keyof typeof labelsByLanguage;
  downloads: ZeusBrowserDownload[];
  onClose: () => void;
  onCommand: (command: DownloadCommand) => Promise<void>;
}) {
  const labels = labelsByLanguage[language];
  /** 取消后行操作会消失，将焦点留在面板。 */
  const closeButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => closeButton.current?.focus(), []);

  return (
    <aside
      id={id}
      aria-label={labels.title}
      className="browser-downloads-panel"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <header>
        <strong>{labels.title}</strong>
        <Button unstyled type="button" ref={closeButton} className="browser-more-trigger" aria-label={labels.close} data-icon-tooltip={labels.close} onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </header>
      {downloads.length === 0 ? (
        <p>{labels.empty}</p>
      ) : (
        <ul>
          {downloads.map((download) => {
            const transferring = download.state === 'downloading';
            const operation = transferring ? 'pause' : download.canResume ? 'resume' : download.state === 'completed' ? 'reveal' : null;
            const knownProgress = download.totalBytes ? Math.floor(Math.min(1, download.receivedBytes / download.totalBytes) * 100) : null;
            const ActionIcon = operation === 'pause' ? Pause : operation === 'resume' ? Play : FolderOpen;
            return (
              <li key={download.id}>
                <FileTypeIcon path={download.fileName} />
                <div className="browser-download-file">
                  <strong title={download.fileName}>{download.fileName}</strong>
                  <small>
                    {labels[download.state]}
                    {transferring && knownProgress !== null ? ` · ${knownProgress}%` : ''}
                  </small>
                  {transferring ? <progress aria-label={download.fileName} max={100} value={knownProgress ?? undefined} /> : null}
                </div>
                {operation ? (
                  <Button
                    unstyled
                    type="button"
                    className="browser-more-trigger"
                    aria-label={`${labels[operation]} · ${download.fileName}`}
                    data-icon-tooltip={labels[operation]}
                    onClick={() => onCommand({ action: 'download', downloadId: download.id, operation })}
                  >
                    <ActionIcon aria-hidden="true" />
                  </Button>
                ) : null}
                {transferring || download.canResume || download.state === 'paused' ? (
                  <Button
                    unstyled
                    type="button"
                    className="browser-more-trigger"
                    aria-label={`${labels.cancel} · ${download.fileName}`}
                    data-icon-tooltip={labels.cancel}
                    onClick={() => {
                      closeButton.current?.focus();
                      return onCommand({ action: 'download', downloadId: download.id, operation: 'cancel' });
                    }}
                  >
                    <X aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
