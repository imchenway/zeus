import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { diffArrays } from 'diff';
import { SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle';
import { CircleNotchIcon } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import type { InputSuggestionResult } from '@zeus/shared';
import { IconTooltip } from '../ui/IconTooltip.js';
import { formatVisibleApplicationError, reportApplicationError } from '../ui/ApplicationErrorDialog.js';
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
  context_unavailable: { 'zh-CN': '暂无可用的对话内容。可先输入目标，再按 Tab 润色。', 'en-US': 'No conversation context is available. Enter your goal, then press Tab to polish it.' },
  /** 专用模型失效时不切换供应商。 */
  model_unavailable: { 'zh-CN': '输入建议模型不可用，请检查通用设置。', 'en-US': 'The suggestion model is unavailable. Check General settings.' },
  /** 显式档位失效需要用户重新选择。 */
  effort_unavailable: { 'zh-CN': '该模型不支持已选推理深度，请在通用设置中重新选择。', 'en-US': 'The selected reasoning effort is unavailable. Choose another in General settings.' },
  /** Fast 能力变化时说明实际限制，不静默降级并产生不同用量。 */
  service_tier_unavailable: { 'zh-CN': '该模型不支持已选 Fast 模式，请在通用设置中选择标准速度或更换模型。', 'en-US': 'Fast mode is unavailable for this model. Choose Standard speed or another model in General settings.' },
  /** 没有合理下一句属于正常结果。 */
  no_suggestion: { 'zh-CN': '暂无合适的输入建议。', 'en-US': 'No suitable input suggestion.' },
  /** 原文可直接使用，不创建没有差异的候选。 */
  no_change: { 'zh-CN': '当前表达已清楚，可以直接使用。', 'en-US': 'Your draft is already clear and ready to use.' },
  /** 每次尝试独立限时，自动重试用尽后仍保留原文。 */
  timed_out: { 'zh-CN': '单次生成超过 20 秒，已停止。原文已保留。', 'en-US': 'The generation attempt stopped after 20 seconds. Your draft is unchanged.' },
  /** 具体原因由应用共用错误入口显示。 */
  failed: { 'zh-CN': '生成失败。', 'en-US': 'Generation failed.' },
  /** 用户取消不额外打扰输入。 */
  cancelled: { 'zh-CN': '', 'en-US': '' },
};

/** 星光按钮固定在输入区右上角，忙碌时同一个入口取消生成。 */
export function InputSuggestionButton(props: { suggestion: SuggestionState; draft: string; inputRef: RefObject<ComposerInputHandle | null>; language: SessionUiLanguage; configured: boolean }) {
  /** 每个输入框独立关联图标和浮层，不与其他会话共用 DOM 身份。 */
  const previewId = useId();
  /** 浮层关闭后键盘焦点可返回原图标。 */
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** 原生浮层负责顶层绘制、外部点击和窗口边缘翻转。 */
  const previewRef = useRef<HTMLDivElement>(null);
  /** 展开状态只反映浮层显示，收起不丢弃候选。 */
  const [previewOpen, setPreviewOpen] = useState(false);
  /** 空输入仍沿用灰字，润色或生成期间继续输入的结果进入同一个预览。 */
  const hasPreview = Boolean(props.suggestion.polishedText && props.suggestion.sourceDraft !== null);
  useEffect(() => {
    // 结果到达时展示一次，不聚焦按钮或编辑器，避免打断用户继续输入。
    if (props.suggestion.polishedText && props.suggestion.sourceDraft !== null) previewRef.current?.showPopover();
  }, [props.suggestion.polishedText, props.suggestion.sourceDraft, props.suggestion.adoptionFailed]);
  /** 配置、超时和生成失败仍占用原图标区域，不在输入框下方增加错误行。 */
  const failed = ['failed', 'timed_out', 'model_unavailable', 'effort_unavailable', 'service_tier_unavailable'].includes(props.suggestion.reason ?? '');
  /** 失败不锁定入口；允许输入时，同一按钮直接重试生成。 */
  const canRetry = failed && props.suggestion.available;
  /** 加载、空结果和错误只进入提示及读屏说明，不进入用户草稿。 */
  const outcomeMessage = props.suggestion.pending
    ? props.suggestion.mode === 'polish'
      ? props.language === 'zh-CN'
        ? '正在润色草稿，可继续输入…'
        : 'Polishing your draft; you can keep typing…'
      : props.language === 'zh-CN'
        ? '正在生成输入建议，可继续输入…'
        : 'Generating a suggestion; you can keep typing…'
    : props.suggestion.reason === 'failed' && props.suggestion.cause
      ? formatVisibleApplicationError(props.suggestion.cause, props.language === 'zh-CN' ? 'zh-CN' : 'en')
      : props.suggestion.reason
        ? feedback[props.suggestion.reason][props.language]
        : '';
  /** 重试进度仍使用同一个图标和提示，等待期间允许取消且不闪现错误。 */
  const message =
    props.suggestion.pending && props.suggestion.retryAttempt > 0
      ? props.language === 'zh-CN'
        ? `${props.suggestion.retryAt ? '暂未生成成功，等待自动重试' : '正在自动重试'}（${props.suggestion.retryAttempt}/2），可继续输入…`
        : `${props.suggestion.retryAt ? 'Waiting to retry' : 'Retrying'} (${props.suggestion.retryAttempt}/2); you can keep typing…`
      : !props.suggestion.pending && failed && props.suggestion.retryAttempt > 0
        ? `${props.language === 'zh-CN' ? '自动重试后仍未成功。' : 'Automatic retry did not succeed. '}${outcomeMessage}`
        : outcomeMessage;
  /** 提示说明点击时将执行的操作，图标不代替名称。 */
  const actionLabel = failed
    ? canRetry
      ? props.language === 'zh-CN'
        ? '点击重试生成'
        : 'Retry generation'
      : props.language === 'zh-CN'
        ? '查看详情'
        : 'View details'
    : !props.configured
      ? props.language === 'zh-CN'
        ? '请先在通用设置选择输入建议模型'
        : 'Choose a suggestion model in General settings'
      : props.suggestion.pending
        ? props.language === 'zh-CN'
          ? '取消生成'
          : 'Cancel generation'
        : hasPreview
          ? previewOpen
            ? props.language === 'zh-CN'
              ? '按当前输入重新生成'
              : 'Generate again from the current draft'
            : props.language === 'zh-CN'
              ? '查看输入建议'
              : 'View suggestion'
          : props.draft.trim()
            ? props.language === 'zh-CN'
              ? '润色草稿'
              : 'Polish draft'
            : props.language === 'zh-CN'
              ? '生成输入建议'
              : 'Suggest the next message';
  /** 状态与操作同时可读，悬停和键盘焦点使用同一个提示。 */
  const shortcut =
    props.suggestion.available && !props.suggestion.pending
      ? props.language === 'zh-CN'
        ? `输入框内按 Tab ${props.suggestion.text || hasPreview ? '采用' : '生成'}；Escape 后按 Tab 移出输入框。`
        : `In the editor, press Tab to ${props.suggestion.text || hasPreview ? 'use the suggestion' : 'generate'}; press Escape then Tab to leave.`
      : '';
  /** 生成、采用和焦点导航的说明与当前状态保持一致。 */
  const label = [message, actionLabel, shortcut].filter(Boolean).join(' ');
  // 容器标记忙碌，按钮保留取消操作，避免全局忙碌按钮样式追加圆点并屏蔽点击。
  return (
    <span className="session-suggestion-action" aria-busy={props.suggestion.pending || undefined}>
      <IconTooltip label={label}>
        <button
          ref={triggerRef}
          type="button"
          className="session-suggestion-button"
          aria-label={label}
          data-error={failed || undefined}
          data-ready={hasPreview || undefined}
          popoverTarget={hasPreview ? previewId : undefined}
          aria-haspopup={hasPreview ? 'dialog' : undefined}
          aria-expanded={hasPreview ? previewOpen : undefined}
          aria-controls={hasPreview ? previewId : undefined}
          disabled={!props.suggestion.available && !props.suggestion.pending && !failed}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            if (props.suggestion.pending) props.suggestion.dismiss();
            else if (canRetry) {
              // 复用主动生成入口，立即进入加载状态；错误原因仍可在重试前悬停或聚焦查看。
              event.preventDefault();
              props.suggestion.requestManual();
            } else if (failed)
              reportApplicationError(props.suggestion.cause ?? message, {
                language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
                title: props.language === 'zh-CN' ? '输入建议生成失败' : 'Input suggestion failed',
                showDetails: true,
              });
            else if (!hasPreview || previewOpen) {
              // 展开时复用同一图标重新生成；收起时仍由原生浮层重新展示已有候选。
              event.preventDefault();
              props.suggestion.requestManual();
            }
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            props.suggestion.dismiss();
          }}
        >
          {props.suggestion.pending ? (
            <CircleNotchIcon className="session-suggestion-spinner" aria-hidden="true" />
          ) : canRetry ? (
            <ArrowClockwiseIcon aria-hidden="true" />
          ) : failed ? (
            <WarningCircleIcon aria-hidden="true" />
          ) : (
            <SparkleIcon aria-hidden="true" />
          )}
        </button>
      </IconTooltip>
      <span className="visually-hidden" role="status">
        {message || (props.suggestion.text || hasPreview ? (props.language === 'zh-CN' ? '输入建议已生成，按 Tab 采用。' : 'Suggestion ready. Press Tab to use it.') : '')}
      </span>
      {hasPreview ? <InputSuggestionPreview {...props} id={previewId} previewRef={previewRef} triggerRef={triggerRef} onOpenChange={setPreviewOpen} /> : null}
    </span>
  );
}

/** 候选只在明确采用后进入编辑器，替换使用可撤销的编辑事务。 */
function InputSuggestionPreview(props: {
  /** 候选和原文必须来自同一次请求。 */
  suggestion: SuggestionState;
  /** 实际编辑器负责原文校验、引用保留及撤销事务。 */
  inputRef: RefObject<ComposerInputHandle | null>;
  /** 控件说明沿用界面语言。 */
  language: SessionUiLanguage;
  /** 原生浮层与触发按钮共用唯一身份。 */
  id: string;
  /** 候选到达时通过原生方法展开。 */
  previewRef: RefObject<HTMLDivElement | null>;
  /** 关闭后返回原图标，不抢占用户在其他区域的焦点。 */
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** 按钮的展开语义跟随原生浮层同步。 */
  onOpenChange: (open: boolean) => void;
}) {
  /** 只在候选变化时对比，按自然词分段并保留空格、换行和完整字符。 */
  const changes = useMemo(() => {
    /** 缺少有效候选时不创建差异内容。 */
    const { sourceDraft, polishedText } = props.suggestion;
    if (sourceDraft === null || !polishedText) return [];
    // 继续输入后旧差异不再对应当前草稿，只展示候选全文并说明替换含义。
    if (props.suggestion.draftChanged) return [{ text: polishedText, changed: false }];
    /** 中英文均使用原生分词，避免把中文整句视为一个词或拆开表情。 */
    const segmenter = new Intl.Segmenter(props.language, { granularity: 'word' });
    /** 所有片段参与比较，空白变化也不能被静默忽略。 */
    const tokenize = (text: string) => Array.from(segmenter.segment(text), (part) => part.segment);
    /** 预览只读最终候选，删除内容仍可在下方原输入框对照。 */
    const parts = (diffArrays(tokenize(sourceDraft), tokenize(polishedText), { timeout: 20, maxEditLength: 1000 }) ?? [{ value: [polishedText], added: true, removed: false }])
      .filter((change) => !change.removed)
      .map((change) => ({ text: change.value.join(''), changed: change.added }));
    /** 合并短小的词间间隔，避免“了”等单字把同一处改写割成色块。 */
    for (let index = 1; index < parts.length - 1; index += 1) {
      if (!parts[index].changed && !parts[index].text.includes('\n') && Array.from(parts[index].text).length <= 2 && parts[index - 1].changed && parts[index + 1].changed) parts[index].changed = true;
    }
    return parts.reduce<Array<{ text: string; changed: boolean }>>((result, part) => {
      /** 单独的标点不染色，改写句段使用连续的轻量强调。 */
      const changed = part.changed && /[\p{L}\p{N}\p{S}]/u.test(part.text);
      /** 相邻同类片段合并，减少视觉边界和 DOM 节点。 */
      const previous = result.at(-1);
      if (previous?.changed === changed) previous.text += part.text;
      else result.push({ text: part.text, changed });
      return result;
    }, []);
  }, [props.suggestion.sourceDraft, props.suggestion.polishedText, props.suggestion.draftChanged, props.language]);
  if (!props.suggestion.polishedText || props.suggestion.sourceDraft === null) return null;
  return (
    <div
      id={props.id}
      ref={props.previewRef}
      popover="auto"
      role="dialog"
      className="session-suggestion-preview"
      aria-label={props.language === 'zh-CN' ? '输入候选预览' : 'Draft preview'}
      onToggle={(event) => props.onOpenChange(event.newState === 'open')}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        props.previewRef.current?.hidePopover();
        props.triggerRef.current?.focus({ preventScroll: true });
      }}
    >
      <div id={`${props.id}-hint`} className="session-suggestion-preview-hint">
        {props.language === 'zh-CN'
          ? props.suggestion.draftChanged
            ? '当前输入已变化。点击或在输入框按 Tab 替换，可撤销。'
            : '点击或在输入框按 Tab 采用，可撤销。'
          : props.suggestion.draftChanged
            ? 'Your draft has changed. Click or press Tab in the editor to replace it; you can undo this change.'
            : 'Click or press Tab in the editor to use this suggestion; you can undo this change.'}
      </div>
      <button
        type="button"
        className="session-suggestion-preview-text"
        aria-label={`${props.language === 'zh-CN' ? '采用建议' : 'Use suggestion'}: ${props.suggestion.polishedText}`}
        aria-describedby={`${props.id}-hint`}
        data-icon-tooltip={props.language === 'zh-CN' ? '点击采用，可撤销' : 'Click to use; you can undo this change'}
        onClick={() => {
          // 点击和 Tab 通过同一入口核对当前输入及引用，替换可以撤销。
          if (!props.suggestion.accept(props.inputRef.current)) return;
          props.inputRef.current?.focus();
        }}
      >
        {changes.map((change, index) => (change.changed ? <mark key={index}>{change.text}</mark> : change.text))}
      </button>
      {props.suggestion.adoptionFailed ? (
        <div role="status">
          {props.language === 'zh-CN'
            ? '当前输入无法替换，或候选未保留引用标签。原文已保留，可点击建议图标按当前输入重新生成。'
            : 'The draft cannot be replaced or a reference tag was altered. Your text is unchanged. Use the suggestion icon to generate again from the current draft.'}
        </div>
      ) : null}
    </div>
  );
}
