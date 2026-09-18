import { monaco, exposeEditorControl } from './monacoRuntime.js';

/** Git 标记选入保持为一次可撤销事务，重新定位前校验原文仍未变化。 */
export function attachSourceConflicts(view: monaco.editor.IStandaloneCodeEditor, zh: boolean, onCompare: (current: string, incoming: string) => void): monaco.IDisposable {
  let zones: string[] = [];
  const decorations = view.createDecorationsCollection();
  function refresh() {
    const model = view.getModel();
    if (!model) return;
    const eol = model.getEOL(),
      lines = model.getLinesContent();
    const markings: monaco.editor.IModelDeltaDecoration[] = [];
    view.changeViewZones((accessor) => {
      zones.forEach((zone) => accessor.removeZone(zone));
      zones = [];
      let start = -1,
        separator = -1,
        base = -1;
      lines.forEach((line, index) => {
        if (/^<{7}(?: |$)/.test(line)) {
          start = index;
          separator = base = -1;
        } else if (start >= 0 && /^\|{7}(?: |$)/.test(line)) base = index;
        else if (start >= 0 && /^={7}\s*$/.test(line)) separator = index;
        else if (start >= 0 && separator >= 0 && /^>{7}(?: |$)/.test(line)) {
          const range = index + 1 < lines.length ? new monaco.Range(start + 1, 1, index + 2, 1) : new monaco.Range(start + 1, 1, index + 1, line.length + 1);
          const original = model.getValueInRange(range);
          const currentLines = lines.slice(start + 1, base >= 0 ? base : separator),
            incomingLines = lines.slice(separator + 1, index);
          const current = currentLines.length ? currentLines.join(eol) + eol : '',
            incoming = incomingLines.length ? incomingLines.join(eol) + eol : '';
          const body = document.createElement('div');
          body.className = 'source-conflict-actions';
          body.setAttribute('role', 'group');
          body.setAttribute('aria-label', zh ? '冲突操作' : 'Conflict actions');
          for (const [label, text] of [
            [zh ? '采用当前' : 'Accept current', current],
            [zh ? '采用传入' : 'Accept incoming', incoming],
            [zh ? '保留双方' : 'Accept both', current + incoming],
            [zh ? '比较变更' : 'Compare changes', null],
          ] as const) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.disabled = text !== null && view.getOption(monaco.editor.EditorOption.readOnly);
            button.onclick = () => {
              if (model.getValueInRange(range) !== original) return;
              if (text === null) {
                onCompare(current, incoming);
                return;
              }
              if (view.getOption(monaco.editor.EditorOption.readOnly)) return;
              view.pushUndoStop();
              view.executeEdits('zeus-conflict', [{ range, text }]);
              view.pushUndoStop();
              view.focus();
            };
            body.append(button);
          }
          zones.push(accessor.addZone({ afterLineNumber: start, heightInPx: 28, domNode: body, suppressMouseDown: false }));
          exposeEditorControl(view, body);
          markings.push(
            { range: new monaco.Range(start + 1, 1, separator + 1, 1), options: { isWholeLine: true, className: 'source-conflict-current' } },
            { range: new monaco.Range(separator + 2, 1, index + 1, 1), options: { isWholeLine: true, className: 'source-conflict-incoming' } },
          );
          start = separator = base = -1;
        }
      });
    });
    decorations.set(markings);
  }
  const change = view.onDidChangeModelContent(refresh);
  refresh();
  return {
    dispose() {
      change.dispose();
      decorations.clear();
      view.changeViewZones((accessor) => zones.forEach((zone) => accessor.removeZone(zone)));
    },
  };
}
