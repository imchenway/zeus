import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';

/** 后缀只属于视图，不进入复制内容、草稿或撤销历史。 */
class CompletionWidget extends WidgetType {
  /** 保留模型返回的衔接空格与换行。 */
  constructor(readonly text: string) {
    super();
  }
  /** 告知编辑器后缀中的显式换行数量，保持多行光标测量正确。 */
  get lineBreaks(): number {
    return this.text.split('\n').length - 1;
  }
  /** 相同文本复用现有 DOM，避免光标附近反复重建。 */
  eq(other: CompletionWidget): boolean {
    return this.text === other.text;
  }
  /** 装饰节点不参与编辑，辅助技术通过输入框描述读取补全。 */
  toDOM(): HTMLElement {
    /** 使用文本节点，模型输出不能成为 HTML。 */
    const span = document.createElement('span');
    span.className = 'cm-inline-completion';
    span.textContent = this.text;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
}

/** 行内补全只适用于已聚焦、无选区且位于文末的普通编辑。 */
export function canAppendCompletion(view: EditorView): boolean {
  return view.hasFocus && !view.composing && !view.state.readOnly && view.state.selection.ranges.length === 1 && view.state.selection.main.empty && view.state.selection.main.head === view.state.doc.length;
}

/** 复用编辑器装饰层；配置变化通过原有空事务或配置事务刷新。 */
export function composerInlineCompletion(
  read: () => {
    /** 当前 React 草稿绑定结果，文档变化时不能展示旧后缀。 */
    draft: string;
    /** 未采用的纯文本后缀。 */
    text?: string | null;
    /** 命令菜单展开时保持菜单自身键盘行为。 */
    menuOpen: boolean;
    /** 将编辑焦点与光标位置交给请求层确定停顿条件。 */
    onActiveChange?: (active: boolean) => void;
  },
) {
  return [
    ViewPlugin.fromClass(
      class {
        /** 装饰永远附着在文档末尾，不改变真实坐标。 */
        decorations: DecorationSet = Decoration.none;
        /** 仅在输入状态变化时通知 React，普通事务不重复更新。 */
        private active: boolean | null = null;
        /** 创建时同步当前视图状态。 */
        constructor(view: EditorView) {
          this.refresh(view);
        }
        /** 输入、选区、焦点及外部候选变化均重新核对。 */
        update(update: { view: EditorView }): void {
          this.refresh(update.view);
        }
        /** 原文必须仍匹配候选；用户继续输入的首个事务立即隐藏旧灰字。 */
        private refresh(view: EditorView): void {
          /** 通过稳定读取函数获得最新候选，避免重建编辑器。 */
          const options = read();
          /** 菜单优先占用 Tab，末尾补全不能遮挡菜单交互。 */
          const active = !options.menuOpen && canAppendCompletion(view);
          if (active !== this.active) {
            this.active = active;
            options.onActiveChange?.(active);
          }
          this.decorations =
            active && options.text && view.state.doc.toString() === options.draft ? Decoration.set([Decoration.widget({ widget: new CompletionWidget(options.text), side: 1 }).range(view.state.doc.length)]) : Decoration.none;
        }
      },
      { decorations: (plugin) => plugin.decorations },
    ),
    EditorView.baseTheme({
      '.cm-inline-completion': { color: 'var(--session-text-muted)', whiteSpace: 'pre-wrap', pointerEvents: 'none', userSelect: 'none' },
    }),
  ];
}
