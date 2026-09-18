import type { UseGitBlameResult } from './useGitBlame.js';
import './blameGutter.css';

export interface SourceBlameLabels {
  locale?: string;
  loading: string;
  unavailable: string;
  retry: string;
}

/** 两个源码入口默认显示归属，仅在加载、暂停或不可用时占用状态栏。 */
export function GitBlameToolbar({ blame, labels, paused }: { blame: UseGitBlameResult; labels: SourceBlameLabels; paused?: string }) {
  if (!blame.available) return null;
  const zh = labels.locale?.startsWith('zh') ?? false;
  const reason = blame.blame?.unavailableReason;
  const emptyMessage = reason
    ? {
        not_repository: zh ? '当前文件不在 Git 仓库中' : 'This file is outside a Git repository',
        no_commits: zh ? '仓库尚无提交记录' : 'This repository has no commits yet',
        uncommitted_file: zh ? '此文件尚未提交，暂无历史归属' : 'This file has not been committed yet',
        not_in_revision: zh ? '所选版本中没有此文件' : 'This file is absent from the selected revision',
      }[reason]
    : blame.blame?.lines.length === 0
      ? zh
        ? '空文件暂无行归属'
        : 'This file has no lines to annotate'
      : null;
  const status = paused || (blame.loading ? labels.loading : emptyMessage);
  const error = !paused && !blame.loading ? blame.error : null;
  if (!status && !error) return null;
  return (
    <div className="session-source-blame-toolbar" role="group" aria-label="Git blame">
      {status ? (
        <span className="session-source-blame-status" role="status">
          {status}
        </span>
      ) : null}
      {error ? (
        <>
          <details className="session-source-blame-error">
            <summary>
              {labels.unavailable} · {zh ? '查看原因' : 'Details'}
            </summary>
            <pre>{error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '')}</pre>
          </details>
          <button type="button" className="session-source-blame-action" onClick={blame.reload}>
            {labels.retry}
          </button>
        </>
      ) : null}
    </div>
  );
}
