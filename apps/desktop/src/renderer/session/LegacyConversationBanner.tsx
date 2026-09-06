import type { NativeConversationChoice } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

export interface LegacyConversationBannerProps {
  conversation: NativeConversationChoice;
  language: SessionUiLanguage;
  onOpenImportSettings?: (conversation: NativeConversationChoice) => void;
}

export function LegacyConversationBanner(props: LegacyConversationBannerProps) {
  const title = props.language === 'zh-CN' ? '旧会话记录为只读' : 'Legacy transcript is read-only';
  const body = props.language === 'zh-CN' ? '这是旧版工具的会话记录。请前往设置导入，以便继续对话。' : 'This conversation comes from an older tool. Import it in Settings to continue the conversation.';
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
