import type { UseGitBlameResult } from './useGitBlame.js';
import './blameGutter.css';

export interface SourceBlameLabels {
  locale?: string;
  show: string;
  hide: string;
  loading: string;
  unavailable: string;
  retry: string;
}

/** 两个源码入口共用开关、加载及失败提示。 */
export function GitBlameToolbar({ blame, labels, paused }: { blame: UseGitBlameResult; labels: SourceBlameLabels; paused?: string }) {
  if (!blame.available) return null;
  return (
    <div className="session-source-blame-toolbar" role="toolbar" aria-label="Git blame">
      <button type="button" className="session-source-blame-toggle" aria-pressed={blame.enabled} onClick={blame.toggle}>
        {blame.enabled ? labels.hide : labels.show}
      </button>
      {blame.enabled && (paused || blame.loading) ? (
        <span className="session-source-blame-status" role="status">
          {paused || labels.loading}
        </span>
      ) : null}
      {blame.enabled && !paused && blame.error ? (
        <>
          <span className="session-source-blame-status" role="status">
            {labels.unavailable}
          </span>
          <button type="button" className="session-source-blame-toggle" onClick={blame.reload}>
            {labels.retry}
          </button>
        </>
      ) : null}
    </div>
  );
}
