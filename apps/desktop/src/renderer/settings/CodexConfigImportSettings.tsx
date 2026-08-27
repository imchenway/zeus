import type {AppShellSettings, CodexConfigImportPreview, CodexConfigImportResult} from '../apiClient.js';
import {useApplicationErrorDialog} from '../ui/ApplicationErrorDialog.js';

interface CodexConfigImportSettingsProps {
  language: AppShellSettings['appLanguage'];
  preview: CodexConfigImportPreview | null;
  result: CodexConfigImportResult | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void | Promise<void>;
  onImport: () => void | Promise<void>;
  onActivate: () => void | Promise<void>;
}

const copy = {
  'zh-CN': {
    title: '从 Codex App 导入配置',
      help: '把 Codex 的指令、规则、提示词、技能以及 Computer/Browser 工具组件复制到 Zeus 专属目录。不会导入账号、密钥或历史会话。',
    scan: '重新检查',
    importing: '正在导入…',
    activating: '正在启用…',
    import: '一键导入',
    activate: '重试启用',
    empty: '没有发现可安全导入的 Codex 配置。',
    source: '来源',
    target: 'Zeus 目录',
    skipped: (count: number) => `另有 ${count} 项因缺失、安全限制、格式不支持或属于可重装运行缓存而跳过。`,
    completed: (count: number, active: boolean) => (active ? `已导入并启用 ${count} 项；新 Codex 会话将直接使用这些配置。` : `已导入 ${count} 项，但新的 Codex 运行服务尚未就绪。`),
  },
  'en-US': {
    title: 'Import configuration from Codex App',
      help: 'Copy Codex instructions, rules, prompts, skills, and Computer/Browser tool components into the Zeus-owned directory. Accounts, secrets, and conversation history are excluded.',
    scan: 'Check again',
    importing: 'Importing…',
    activating: 'Enabling…',
    import: 'Import now',
    activate: 'Retry enabling',
    empty: 'No Codex configuration is available for safe import.',
    source: 'Source',
    target: 'Zeus directory',
    skipped: (count: number) => `${count} additional item(s) were skipped because they are missing, unsafe, unsupported, or generated runtime cache.`,
    completed: (count: number, active: boolean) => (active ? `${count} item(s) imported and enabled. New Codex conversations will use this configuration.` : `${count} item(s) imported, but the fresh Codex runtime is not ready.`),
  },
} as const;

export function CodexConfigImportSettings(props: CodexConfigImportSettingsProps) {
  const labels = copy[props.language];
  const activationRequired = Boolean(props.result && props.result.imported.length > 0 && !props.result.runtimeReloaded);
  useApplicationErrorDialog(props.error, {
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
  });
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
      {props.result && props.result.imported.length > 0 ? <p role="status">{labels.completed(props.result.imported.length, props.result.runtimeReloaded)}</p> : null}
      <footer className="legacy-import-command-row">
        <span />
        <button type="button" disabled={props.loading || (!activationRequired && !props.preview?.available)} onClick={() => void (activationRequired ? props.onActivate() : props.onImport())}>
          {props.loading ? (activationRequired ? labels.activating : labels.importing) : activationRequired ? labels.activate : labels.import}
        </button>
      </footer>
    </section>
  );
}
