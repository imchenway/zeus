import type { NativeConversationChoice } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

export interface LegacyConversationBannerProps {
  conversation: NativeConversationChoice;
  language: SessionUiLanguage;
  onOpenImportSettings?: (conversation: NativeConversationChoice) => void;
}

export function LegacyConversationBanner(props: LegacyConversationBannerProps) {
  const title = props.language === 'zh-CN' ? '旧会话记录为只读' : 'Legacy transcript is read-only';
  const body =
    props.language === 'zh-CN' ? '该记录来自旧 CLI。前往设置导入后，Codex 会生成可直接续接的原生会话。' : 'This record came from the legacy CLI. Import it in Settings to create a native Codex conversation that can be resumed directly.';
  const action = props.language === 'zh-CN' ? '前往设置导入' : 'Import in Settings';
  return (
    <section className="session-legacy-banner" role="status" aria-label={title}>
      <span className="session-legacy-banner-icon" aria-hidden="true">
        ↗
      </span>
      <span>
        <strong>{title}</strong>
        <p>{body}</p>
      </span>
      {props.onOpenImportSettings ? (
        <button type="button" onClick={() => props.onOpenImportSettings?.(props.conversation)}>
          {action}
        </button>
      ) : null}
    </section>
  );
}
