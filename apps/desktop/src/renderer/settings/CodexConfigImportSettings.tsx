import type { AppShellSettings, CodexConfigImportPreview, CodexConfigImportResult } from '../apiClient.js';

interface CodexConfigImportSettingsProps {
  language: AppShellSettings['appLanguage'];
  preview: CodexConfigImportPreview | null;
  result: CodexConfigImportResult | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void | Promise<void>;
  onImport: () => void | Promise<void>;
}

const copy = {
  'zh-CN': {
    title: '从 Codex App 导入配置',
    help: '把 Codex 的指令、规则、提示词、技能和插件复制到 Zeus 专属目录。不会导入账号、密钥或历史会话。',
    scan: '重新检查',
    importing: '正在导入…',
    import: '一键导入',
    empty: '没有发现可安全导入的 Codex 配置。',
    source: '来源',
    target: 'Zeus 目录',
    skipped: (count: number) => `另有 ${count} 项因缺失、安全限制或格式不支持而跳过。`,
    completed: (count: number) => `已导入 ${count} 项。重启 Zeus 后，新 Codex 会话开始使用这些配置。`,
  },
  'en-US': {
    title: 'Import configuration from Codex App',
    help: 'Copy Codex instructions, rules, prompts, skills, and plugins into the Zeus-owned directory. Accounts, secrets, and conversation history are excluded.',
    scan: 'Check again',
    importing: 'Importing…',
    import: 'Import now',
    empty: 'No Codex configuration is available for safe import.',
    source: 'Source',
    target: 'Zeus directory',
    skipped: (count: number) => `${count} additional item(s) were skipped because they are missing, unsafe, or unsupported.`,
    completed: (count: number) => `${count} item(s) imported. Restart Zeus before starting a new Codex conversation.`,
  },
} as const;

export function CodexConfigImportSettings(props: CodexConfigImportSettingsProps) {
  const labels = copy[props.language];
  return (
    <section className="legacy-import-settings" aria-labelledby="codex-config-import-title">
      <header className="legacy-import-heading">
        <span>
          <strong id="codex-config-import-title">{labels.title}</strong>
          <small>{labels.help}</small>
        </span>
        <button type="button" className="legacy-import-refresh" onClick={() => void props.onRefresh()} disabled={props.loading}>
          {labels.scan}
        </button>
      </header>
      {props.error ? (
        <p role="alert" className="legacy-import-error">
          {props.error}
        </p>
      ) : null}
      {props.preview ? (
        <span className="settings-row-copy">
          <small>
            {labels.source}：{props.preview.sourceRoot}
          </small>
          <small>
            {labels.target}：{props.preview.targetRoot}
          </small>
        </span>
      ) : null}
      {!props.loading && props.preview && !props.preview.available ? <p className="legacy-import-empty">{labels.empty}</p> : null}
      {(props.preview?.entries.length ?? 0) > 0 ? (
        <ul className="legacy-import-history" aria-label={labels.title}>
          {props.preview?.entries.map((entry) => (
            <li key={entry.path}>
              <strong>{entry.path}</strong>
              <small>{entry.nodeCount}</small>
            </li>
          ))}
        </ul>
      ) : null}
      {(props.preview?.skipped.length ?? 0) > 0 ? <small>{labels.skipped(props.preview!.skipped.length)}</small> : null}
      {props.result ? <p role="status">{labels.completed(props.result.imported.length)}</p> : null}
      <footer className="legacy-import-command-row">
        <span />
        <button type="button" disabled={props.loading || !props.preview?.available} onClick={() => void props.onImport()}>
          {props.loading ? labels.importing : labels.import}
        </button>
      </footer>
    </section>
  );
}
