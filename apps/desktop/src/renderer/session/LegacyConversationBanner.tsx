import type { SessionUiLanguage } from './ThreadItemView.js';

/** 旧会话只读说明跟随界面语言。 */
export interface LegacyConversationBannerProps {
  language: SessionUiLanguage;
}

/** 保留历史记录的只读说明，不再引导到已移除的导入设置。 */
export function LegacyConversationBanner(props: LegacyConversationBannerProps) {
  /** 明确旧记录不能直接接续。 */
  const title = props.language === 'zh-CN' ? '旧会话记录为只读' : 'Legacy transcript is read-only';
  /** 引导用户通过现有新建会话入口开始对话。 */
  const body = props.language === 'zh-CN' ? '这是旧版工具的会话记录，仅供查阅。如需对话，请新建会话。' : 'This conversation comes from an older tool and is available for reference only. Start a new conversation to chat.';
  return (
    <section className="session-legacy-banner" role="status" aria-label={title}>
      <span className="session-legacy-banner-icon" aria-hidden="true">
        ↗
      </span>
      <span>
        <strong>{title}</strong>
        <p>{body}</p>
      </span>
    </section>
  );
}
