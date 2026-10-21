import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from '@codemirror/view';
import type { GitBlameLine } from '../features/git/gitContracts.js';
import { hasBlameCommit } from './blamePresentation.js';

/** 原文件按行读取，差异视图通过显示行解析前后版本的真实归属。 */
export type BlameSource = readonly GitBlameLine[] | ((displayLine: number) => GitBlameLine | undefined);

/** 仅在编辑器聚焦且光标为单点时展示当前行；编辑后立即隐藏旧归属，等待磁盘版本刷新。 */
export function blameDecorations(source: BlameSource, labels: { locale?: string }) {
  /** 原文件只索引真实提交；差异视图复用版本索引，并在解析当前行后使用同一规则过滤。 */
  const byLine = typeof source === 'function' ? null : new Map(source.filter(hasBlameCommit).map((line) => [line.line, line]));
  if (byLine?.size === 0) return [];
  /** 光标移动时只解析当前行，不遍历整个文件。 */
  const resolveLine = typeof source === 'function' ? source : (line: number) => byLine?.get(line);
  return ViewPlugin.define(
    (view) => ({
      stale: false,
      decorations: activeBlameDecorations(view, resolveLine, labels),
      update(update: ViewUpdate) {
        if (update.docChanged) this.stale = true;
        if (update.docChanged || update.selectionSet || update.focusChanged || update.viewportChanged) {
          this.decorations = this.stale ? Decoration.none : activeBlameDecorations(update.view, resolveLine, labels);
        }
      },
    }),
    { decorations: (plugin) => plugin.decorations },
  );
}

/** 当前单光标沿用原来的行尾详情，差异补位行没有归属时不生成提示。 */
function activeBlameDecorations(view: EditorView, resolveLine: (line: number) => GitBlameLine | undefined, labels: { locale?: string }) {
  const selection = view.state.selection;
  if (!view.hasFocus || selection.ranges.length !== 1 || !selection.main.empty) return Decoration.none;
  const line = view.state.doc.lineAt(selection.main.head);
  const blame = resolveLine(line.number);
  if (!hasBlameCommit(blame) || !view.visibleRanges.some((range) => line.to >= range.from && line.to <= range.to)) return Decoration.none;
  return Decoration.set([Decoration.widget({ widget: new BlameWidget(blame, labels), side: 1 }).range(line.to)]);
}

/** 行尾简要信息可直接阅读，统一提示保留 commit、作者和绝对时间等完整信息。 */
class BlameWidget extends WidgetType {
  constructor(
    private readonly blame: GitBlameLine,
    private readonly labels: { locale?: string },
  ) {
    super();
  }

  eq(other: BlameWidget): boolean {
    return (
      this.blame.commitHash === other.blame.commitHash &&
      this.blame.line === other.blame.line &&
      this.blame.subject === other.blame.subject &&
      this.blame.author === other.blame.author &&
      this.blame.authorTime === other.blame.authorTime &&
      this.labels.locale === other.labels.locale
    );
  }

  toDOM(): HTMLElement {
    /** 外层继承代码行高，内层独立设置注释字号，避免裁剪改变基线。 */
    const element = document.createElement('span');
    /** 长归属信息在同一行省略，完整详情由外层统一提示提供。 */
    const text = document.createElement('span');
    /** 装饰只接收已确认的真实作者，不生成 Unknown 占位。 */
    const author = this.blame.author.trim();
    /** 相对时间使用当前界面语言。 */
    const relativeTime = formatRelativeTime(this.blame.authorTime, this.labels.locale);
    /** 无提交说明时显示已有短提交号。 */
    const subject = this.blame.subject || this.blame.shortHash;
    element.className = 'session-source-blame-inline';
    text.className = 'session-source-blame-text';
    text.textContent = `${author}, ${relativeTime} • ${subject}`;
    element.append(text);
    element.dataset.iconTooltip = [author, formatAbsoluteTime(this.blame.authorTime, this.labels.locale), this.blame.shortHash, this.blame.subject].filter(Boolean).join('\n');
    element.setAttribute('aria-label', `${author}, ${relativeTime}, ${subject}`);
    return element;
  }
}

function formatRelativeTime(timestamp: number, locale = 'en-US'): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return locale.startsWith('zh') ? '时间未知' : 'unknown time';
  const elapsedSeconds = Math.max(0, (Date.now() - timestamp * 1_000) / 1_000);
  const units = [
    { seconds: 365 * 24 * 60 * 60, unit: 'year' as const },
    { seconds: 30 * 24 * 60 * 60, unit: 'month' as const },
    { seconds: 24 * 60 * 60, unit: 'day' as const },
    { seconds: 60 * 60, unit: 'hour' as const },
    { seconds: 60, unit: 'minute' as const },
  ];
  const selected = units.find((candidate) => elapsedSeconds >= candidate.seconds);
  if (!selected) return locale.startsWith('zh') ? '刚刚' : 'just now';
  const value = -Math.max(1, Math.floor(elapsedSeconds / selected.seconds));
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, selected.unit);
  } catch {
    return `${Math.abs(value)} ${selected.unit}${Math.abs(value) === 1 ? '' : 's'} ago`;
  }
}

function formatAbsoluteTime(timestamp: number, locale = 'en-US'): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return locale.startsWith('zh') ? '时间未知' : 'Unknown time';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp * 1_000));
  } catch {
    return new Date(timestamp * 1_000).toISOString();
  }
}
