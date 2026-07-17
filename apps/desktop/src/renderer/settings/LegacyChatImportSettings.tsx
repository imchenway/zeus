import { useEffect, useMemo, useState } from 'react';
import type { AppShellSettings, CodexLegacyImportSnapshot } from '../apiClient.js';

interface LegacyChatImportSettingsProps {
  language: AppShellSettings['appLanguage'];
  snapshot: CodexLegacyImportSnapshot | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onRefresh: () => void | Promise<void>;
  onImport: (sourceConversationIds: string[]) => void | Promise<void>;
}

const copy = {
  'zh-CN': {
    title: '旧会话导入',
    help: '把 Zeus 旧会话复制为 Codex 原生会话。导入成功后，旧记录会归档，原始数据不会被覆盖。',
    loading: '正在检查可导入的旧会话…',
    empty: '没有可导入的旧会话。',
    select: '选择要导入的旧会话',
    importSelected: '导入所选会话',
    refresh: '重新检查',
    selected: (count: number) => `已选择 ${count} 个`,
    completed: '已导入',
    waiting: '导入中',
    prepared: '准备中',
    failed: '导入失败',
  },
  'en-US': {
    title: 'Import legacy conversations',
    help: 'Copy legacy Zeus conversations into native Codex conversations. Successful imports archive the legacy record without overwriting its source data.',
    loading: 'Checking for legacy conversations…',
    empty: 'No legacy conversations are available to import.',
    select: 'Choose legacy conversations to import',
    importSelected: 'Import selected',
    refresh: 'Check again',
    selected: (count: number) => `${count} selected`,
    completed: 'Imported',
    waiting: 'Importing',
    prepared: 'Preparing',
    failed: 'Import failed',
  },
} as const;

export function LegacyChatImportSettings(props: LegacyChatImportSettingsProps) {
  const labels = copy[props.language];
  const eligibleIds = useMemo(() => props.snapshot?.eligible.map((entry) => entry.sourceConversationId) ?? [], [props.snapshot]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelected((current) => {
      const eligible = new Set(eligibleIds);
      const retained = new Set([...current].filter((id) => eligible.has(id)));
      if (retained.size > 0 || current.size > 0) return retained;
      return new Set(eligibleIds);
    });
  }, [eligibleIds]);

  return (
    <section className="legacy-import-settings" aria-labelledby="legacy-import-settings-title">
      <header className="legacy-import-heading">
        <span>
          <strong id="legacy-import-settings-title">{labels.title}</strong>
          <small>{labels.help}</small>
        </span>
        <button type="button" className="legacy-import-refresh" onClick={() => void props.onRefresh()} disabled={props.loading || props.busy}>
          {labels.refresh}
        </button>
      </header>
      {props.error ? (
        <p role="alert" className="legacy-import-error">
          {props.error}
        </p>
      ) : null}
      {props.loading ? <p role="status">{labels.loading}</p> : null}
      {!props.loading && props.snapshot?.eligible.length === 0 ? <p className="legacy-import-empty">{labels.empty}</p> : null}
      {(props.snapshot?.eligible.length ?? 0) > 0 ? (
        <fieldset className="legacy-import-picker" disabled={props.busy}>
          <legend>{labels.select}</legend>
          {props.snapshot?.eligible.map((entry) => (
            <label key={entry.sourceConversationId} className="legacy-import-row">
              <input
                type="checkbox"
                checked={selected.has(entry.sourceConversationId)}
                onChange={(event) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (event.currentTarget.checked) next.add(entry.sourceConversationId);
                    else next.delete(entry.sourceConversationId);
                    return next;
                  })
                }
              />
              <span>
                <strong>{entry.title}</strong>
                <small>{entry.cwd}</small>
              </span>
            </label>
          ))}
          <footer className="legacy-import-command-row">
            <span aria-live="polite">{labels.selected(selected.size)}</span>
            <button type="button" disabled={props.busy || selected.size === 0} onClick={() => void props.onImport([...selected])}>
              {labels.importSelected}
            </button>
          </footer>
        </fieldset>
      ) : null}
      {(props.snapshot?.runs.length ?? 0) > 0 ? (
        <ul className="legacy-import-history" aria-label={labels.title}>
          {props.snapshot?.runs.map((run) => (
            <li key={run.id} data-status={run.status}>
              <span>
                <strong>{run.sourceConversationId}</strong>
                {run.failureMessage ? <small>{run.failureMessage}</small> : null}
              </span>
              <em>{labels[run.status]}</em>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
