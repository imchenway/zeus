import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from '@codemirror/view';
import type { GitBlameLine } from '../features/git/gitContracts.js';

/** 仅在编辑器聚焦且光标为单点时展示当前行；编辑后立即隐藏旧归属，等待磁盘版本刷新。 */
export function blameDecorations(lines: GitBlameLine[], labels: { locale?: string }) {
  const byLine = new Map(lines.map((line) => [line.line, line]));
  return ViewPlugin.define(
    (view) => ({
      stale: false,
      decorations: activeBlameDecorations(view, byLine, labels),
      update(update: ViewUpdate) {
        if (update.docChanged) this.stale = true;
        if (update.docChanged || update.selectionSet || update.focusChanged || update.viewportChanged) {
          this.decorations = this.stale ? Decoration.none : activeBlameDecorations(update.view, byLine, labels);
        }
      },
    }),
    { decorations: (plugin) => plugin.decorations },
  );
}

function activeBlameDecorations(view: EditorView, byLine: Map<number, GitBlameLine>, labels: { locale?: string }) {
  const selection = view.state.selection;
  if (!view.hasFocus || selection.ranges.length !== 1 || !selection.main.empty) return Decoration.none;
  const line = view.state.doc.lineAt(selection.main.head);
  const blame = byLine.get(line.number);
  if (!blame || !view.visibleRanges.some((range) => line.to >= range.from && line.to <= range.to)) return Decoration.none;
  return Decoration.set([Decoration.widget({ widget: new BlameWidget(blame, labels), side: 1 }).range(line.to)]);
}

/** 行尾简要信息可直接阅读，原生 title 保留 commit、作者和绝对时间等完整信息。 */
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
    const element = document.createElement('span');
    const author = this.blame.author || 'Unknown';
    const relativeTime = formatRelativeTime(this.blame.authorTime, this.labels.locale);
    const subject = this.blame.subject || this.blame.shortHash;
    element.className = 'session-source-blame-inline';
    element.textContent = `${author}, ${relativeTime} • ${subject}`;
    element.title = [author, formatAbsoluteTime(this.blame.authorTime, this.labels.locale), this.blame.shortHash, this.blame.subject].filter(Boolean).join('\n');
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
