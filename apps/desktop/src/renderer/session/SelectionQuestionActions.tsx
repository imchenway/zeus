import { SidebarSimpleIcon } from '@phosphor-icons/react/dist/csr/SidebarSimple';
import { LightbulbIcon } from '@phosphor-icons/react/dist/csr/Lightbulb';
import type { SessionUiLanguage } from './ThreadItemView.js';

/** 回答和文件选区共用提问、解释按钮，并在点击时保留原选区。 */
export function SelectionQuestionActions(props: {
  /** 提示和无障碍名称沿用当前界面语言。 */
  language: SessionUiLanguage;
  /** 普通提问暂存引用，解释直接发送引用。 */
  onAsk: (sendImmediately: boolean) => void;
}) {
  /** 两种操作使用与会话一致的简短文案。 */
  const zh = props.language === 'zh-CN';
  return (
    <>
      <button type="button" aria-label={zh ? '在侧边栏提问' : 'Ask in sidebar'} data-icon-tooltip={zh ? '在侧边栏提问' : 'Ask in sidebar'} onPointerDown={(event) => event.preventDefault()} onClick={() => props.onAsk(false)}>
        <SidebarSimpleIcon aria-hidden="true" />
      </button>
      <button type="button" aria-label={zh ? '解释选中文字' : 'Explain selected text'} data-icon-tooltip={zh ? '解释' : 'Explain'} onPointerDown={(event) => event.preventDefault()} onClick={() => props.onAsk(true)}>
        <LightbulbIcon aria-hidden="true" />
      </button>
    </>
  );
}
