import { useState, type RefObject } from 'react';
import { SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle';
import { CircleNotchIcon } from '@phosphor-icons/react/dist/csr/CircleNotch';
import type { InputSuggestionResult } from '@zeus/shared';
import { Button } from '../ui/Button.js';
import { IconTooltip } from '../ui/IconTooltip.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import type { ComposerInputHandle } from './MarkdownComposerEditor.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import type { useInputSuggestion } from './useInputSuggestion.js';

/** 已有会话和新建草稿共用同一交互状态。 */
type SuggestionState = ReturnType<typeof useInputSuggestion>;

/** 状态文字独立于正文，不能被 Tab 采纳或随消息发送。 */
const feedback: Record<NonNullable<InputSuggestionResult['reason']>, Record<SessionUiLanguage, string>> = {
  /** 自动开关关闭不影响主动入口。 */
  disabled: { 'zh-CN': '自动输入建议已关闭。', 'en-US': 'Automatic input suggestions are off.' },
  /** 没有对话时仍可输入草稿后主动润色。 */
  context_unavailable: { 'zh-CN': '暂无可用的对话内容。可先输入草稿，再点击润色。', 'en-US': 'No conversation context is available. Enter a draft to polish it.' },
  /** 专用模型失效时不切换供应商。 */
  model_unavailable: { 'zh-CN': '输入建议模型不可用，请检查通用设置。', 'en-US': 'The suggestion model is unavailable. Check General settings.' },
  /** 显式档位失效需要用户重新选择。 */
  effort_unavailable: { 'zh-CN': '该模型不支持已选推理深度，请在通用设置中重新选择。', 'en-US': 'The selected reasoning effort is unavailable. Choose another in General settings.' },
  /** 没有合理下一句属于正常结果。 */
  no_suggestion: { 'zh-CN': '暂无合适的输入建议。', 'en-US': 'No suitable input suggestion.' },
  /** 原文可直接使用，不创建没有差异的候选。 */
  no_change: { 'zh-CN': '当前表达已清楚，可以直接使用。', 'en-US': 'Your draft is already clear and ready to use.' },
  /** 超时后保留原文，用户可主动再次点击。 */
  timed_out: { 'zh-CN': '生成超过 20 秒，已停止。原文已保留。', 'en-US': 'Generation stopped after 20 seconds. Your draft is unchanged.' },
  /** 具体原因由应用共用错误入口显示。 */
  failed: { 'zh-CN': '生成失败。', 'en-US': 'Generation failed.' },
  /** 用户取消不额外打扰输入。 */
  cancelled: { 'zh-CN': '', 'en-US': '' },
};

/** 星光按钮固定在输入区右上角，忙碌时同一个入口取消生成。 */
export function InputSuggestionButton(props: { suggestion: SuggestionState; draft: string; language: SessionUiLanguage; configured: boolean }) {
  /** 提示说明点击时将执行的操作，图标不代替名称。 */
  const label = !props.configured
    ? props.language === 'zh-CN'
      ? '请先在通用设置选择输入建议模型'
      : 'Choose a suggestion model in General settings'
    : props.suggestion.pending
      ? props.language === 'zh-CN'
        ? '取消生成'
        : 'Cancel generation'
      : props.draft.trim()
        ? props.language === 'zh-CN'
          ? '润色草稿'
          : 'Polish draft'
        : props.language === 'zh-CN'
          ? '生成输入建议'
          : 'Suggest the next message';
  return (
    <span className="session-suggestion-action">
      <IconTooltip label={label}>
        <button
          type="button"
          className="session-suggestion-button"
          aria-label={label}
          aria-busy={props.suggestion.pending || undefined}
          disabled={!props.suggestion.available && !props.suggestion.pending}
          onMouseDown={(event) => event.preventDefault()}
          onClick={props.suggestion.pending ? props.suggestion.dismiss : props.suggestion.requestManual}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            props.suggestion.dismiss();
          }}
        >
          {props.suggestion.pending ? <CircleNotchIcon className="session-suggestion-spinner" aria-hidden="true" /> : <SparkleIcon aria-hidden="true" />}
        </button>
      </IconTooltip>
    </span>
  );
}

/** 候选只在明确采用后进入编辑器，替换使用可撤销的编辑事务。 */
export function InputSuggestionPreview(props: { suggestion: SuggestionState; inputRef: RefObject<ComposerInputHandle | null>; language: SessionUiLanguage }) {
  /** 引用标签未完整保留时拒绝采用，不能悄悄删除执行意图。 */
  const [failedCandidate, setFailedCandidate] = useState<{ text: string; source: string } | null>(null);
  if (!props.suggestion.polishedText || props.suggestion.sourceDraft === null) return null;
  return (
    <section
      className="session-suggestion-preview"
      aria-label={props.language === 'zh-CN' ? '输入候选预览' : 'Draft preview'}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        props.suggestion.dismiss();
        props.inputRef.current?.focus();
      }}
    >
      <strong>{props.suggestion.mode === 'polish' ? (props.language === 'zh-CN' ? '润色建议' : 'Polished draft') : props.language === 'zh-CN' ? '输入建议' : 'Input suggestion'}</strong>
      <div className="session-suggestion-preview-text" data-zeus-selectable="text">
        {props.suggestion.polishedText}
      </div>
      {failedCandidate?.text === props.suggestion.polishedText && failedCandidate.source === props.suggestion.sourceDraft ? (
        <p role="status">{props.language === 'zh-CN' ? '原文已变化，或结果未保留引用标签。请保留原文并重新生成。' : 'The draft changed or a reference tag was altered. Keep your draft and generate again.'}</p>
      ) : null}
      <div className="session-suggestion-preview-actions">
        <Button
          size="compact"
          variant="primary"
          onClick={() => {
            /** 编辑器再次核对原文和结构化引用，按钮出现并不代表原文仍未变化。 */
            const adopted = props.inputRef.current?.replaceDraft?.(props.suggestion.sourceDraft!, props.suggestion.polishedText!) === true;
            if (!adopted) {
              setFailedCandidate({ text: props.suggestion.polishedText!, source: props.suggestion.sourceDraft! });
              return;
            }
            props.suggestion.dismiss();
            props.inputRef.current?.focus();
          }}
        >
          {props.language === 'zh-CN' ? '采用' : 'Use this'}
        </Button>
        <Button size="compact" variant="secondary" onClick={props.suggestion.dismiss}>
          {props.language === 'zh-CN' ? '保留原文' : 'Keep original'}
        </Button>
        <small>{props.language === 'zh-CN' ? '采用后可撤销' : 'You can undo this change'}</small>
      </div>
    </section>
  );
}

/** 加载、空结果和故障均保留在输入区，不自动打开弹窗。 */
export function InputSuggestionStatus(props: { suggestion: SuggestionState; language: SessionUiLanguage }) {
  /** 润色与预测分别说明当前操作。 */
  const message = props.suggestion.pending
    ? props.suggestion.mode === 'polish'
      ? props.language === 'zh-CN'
        ? '正在润色草稿…'
        : 'Polishing your draft…'
      : props.language === 'zh-CN'
        ? '正在生成输入建议…'
        : 'Generating a suggestion…'
    : props.suggestion.reason
      ? feedback[props.suggestion.reason][props.language]
      : '';
  return message ? (
    <p className="session-composer-suggestion-status" role="status">
      {props.suggestion.reason === 'failed' && props.suggestion.cause ? <VisibleApplicationError error={props.suggestion.cause} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} title={message} /> : message}
    </p>
  ) : null;
}
