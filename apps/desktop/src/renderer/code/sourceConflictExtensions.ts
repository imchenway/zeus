import { StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

/** 只对完整的 Git 冲突标记提供操作；修改保留在编辑器草稿，可撤销。 */
export function sourceConflictExtensions(zh: boolean, onCompare: (current: string, incoming: string) => void) {
  function decorations(viewState: import('@codemirror/state').EditorState): DecorationSet {
    const doc = viewState.doc;
    const ranges = [];
    let start = 0;
    let separator = 0;
    let base = 0;
    for (let number = 1; number <= doc.lines; number++) {
      const line = doc.line(number);
      if (/^<{7}(?: |$)/.test(line.text)) {
        start = number;
        separator = 0;
        base = 0;
      } else if (start && /^\|{7}(?: |$)/.test(line.text)) base = number;
      else if (start && /^={7}\s*$/.test(line.text)) separator = number;
      else if (start && separator && /^>{7}(?: |$)/.test(line.text)) {
        const from = doc.line(start).from;
        const to = number < doc.lines ? line.to + 1 : line.to;
        const current = doc.sliceString(doc.line(start).to + 1, doc.line(base || separator).from);
        const incoming = doc.sliceString(doc.line(separator).to + 1, line.from);
        const original = doc.sliceString(from, to);
        ranges.push(Decoration.widget({ widget: new Actions(from, to, original, current, incoming, zh, onCompare), side: -1, block: true }).range(from));
        for (let row = start; row <= number; row++) ranges.push(Decoration.line({ class: row < separator ? 'source-conflict-current' : 'source-conflict-incoming' }).range(doc.line(row).from));
        start = 0;
      }
    }
    return Decoration.set(ranges, true);
  }
  return [
    StateField.define<DecorationSet>({
      create: decorations,
      update: (value, transaction) => (transaction.docChanged ? decorations(transaction.state) : value),
      provide: (field) => EditorView.decorations.from(field),
    }),
    EditorView.theme({
      '.source-conflict-current': { backgroundColor: 'color-mix(in srgb, #249b83 20%, transparent)' },
      '.source-conflict-incoming': { backgroundColor: 'color-mix(in srgb, #408bd8 20%, transparent)' },
      '.source-conflict-actions': {
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '2px',
        padding: '4px 6px',
        background: 'var(--zeus-product-panel-muted)',
        borderBottom: '1px solid var(--zeus-control-border)',
        fontFamily: 'var(--zeus-font-family, system-ui)',
      },
      '.source-conflict-actions button': {
        appearance: 'none',
        border: '0',
        borderRadius: '4px',
        background: 'transparent',
        color: 'var(--zeus-product-muted)',
        font: 'inherit',
        fontSize: '12px',
        fontWeight: '500',
        lineHeight: '20px',
        padding: '2px 7px',
        cursor: 'pointer',
      },
      '.source-conflict-actions button:hover': { background: 'var(--zeus-interaction-hover)', color: 'var(--zeus-control-text)' },
      '.source-conflict-actions button:focus-visible': { outline: '2px solid var(--zeus-control-focus)', outlineOffset: '-2px' },
      '.source-conflict-actions button + button': { borderInlineStart: '1px solid var(--zeus-control-border)' },
    }),
  ];
}

class Actions extends WidgetType {
  constructor(
    readonly from: number,
    readonly to: number,
    readonly original: string,
    readonly current: string,
    readonly incoming: string,
    readonly zh: boolean,
    readonly onCompare: (current: string, incoming: string) => void,
  ) {
    super();
  }
  toDOM(view: EditorView) {
    const root = document.createElement('div');
    root.className = 'source-conflict-actions';
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', this.zh ? '冲突操作' : 'Conflict actions');
    for (const [label, content] of [
      [this.zh ? '采用当前更改' : 'Accept current', this.current],
      [this.zh ? '采用传入更改' : 'Accept incoming', this.incoming],
      [this.zh ? '保留双方更改' : 'Accept both', this.current + this.incoming],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.onclick = () => {
        if (view.state.readOnly || view.state.doc.sliceString(this.from, this.to) !== this.original) return;
        view.dispatch({ changes: { from: this.from, to: this.to, insert: content }, userEvent: 'input' });
        view.focus();
      };
      root.append(button);
    }
    const compare = document.createElement('button');
    compare.type = 'button';
    compare.textContent = this.zh ? '比较变更' : 'Compare changes';
    compare.onclick = () => {
      if (view.state.doc.sliceString(this.from, this.to) === this.original) this.onCompare(this.current, this.incoming);
    };
    root.append(compare);
    return root;
  }
  ignoreEvent() {
    return true;
  }
}
