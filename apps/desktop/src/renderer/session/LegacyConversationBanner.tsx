import type { SessionUiLanguage } from './ThreadItemView.js';

/** 旧会话只读状态跟随界面语言。 */
export interface LegacyConversationBannerProps {
  language: SessionUiLanguage;
}

/** 在底部操作旁说明旧记录不能直接接续。 */
export function LegacyConversationBanner(props: LegacyConversationBannerProps) {
  return (
    <p className="session-legacy-readonly" role="status">
      {props.language === 'zh-CN' ? '旧会话 · 只读' : 'Legacy conversation · Read-only'}
    </p>
  );
}
