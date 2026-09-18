import { memo, useEffect, useRef, useState } from 'react';
import { monaco, initializeSourceEditor, editorLanguage, ensureSourceModel, createTransientSourceModel } from './monacoRuntime.js';
import { loadEditorGrammar } from './monacoGrammars.js';
import { sourceModelKey, sourceModels, sourceWorkspaces } from './sourceEditorState.js';

export interface CodeTextChange {
  from: number;
  to: number;
  insertedLength: number;
}
export interface CodeEditorProps {
  path: string;
  projectId?: string;
  language: string | null;
  content: string;
  savedContent?: string;
  readOnly: boolean;
  label?: string;
  revealLine?: number | null;
  revealColumn?: number | null;
  options?: monaco.editor.IStandaloneEditorConstructionOptions;
  onChange?(content: string, change: CodeTextChange): void;
  onDocumentChange?(content: string, dirty: boolean): void;
  onCursorChange?(line: number, column: number): void;
  onSave?(): void;
  onSaveAll?(): void;
  onView?(view: monaco.editor.IStandaloneCodeEditor | null): void;
}

/** 原生模型跨标签保留，React 只接收内容快照和光标状态。 */
export const CodeEditor = memo(function CodeEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const current = useRef(props);
  current.current = props;
  const [error, setError] = useState('');
  const [ready, setReady] = useState(0);
  const applying = useRef(false);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    setError('');
    void initializeSourceEditor()
      .then(async () => {
        await loadEditorGrammar(editorLanguage(props.path, props.language));
        if (disposed || !host.current) return;
        const input = current.current;
        const key = input.projectId ? sourceModelKey(input.projectId, input.path) : null;
        const temporary = input.projectId ? undefined : await createTransientSourceModel(input.content, editorLanguage(input.path, input.language));
        const model = temporary?.model ?? (await ensureSourceModel(input.projectId!, input.path, { content: input.content, language: input.language }));
        if (disposed || !host.current) {
          temporary?.dispose();
          if (input.projectId && !sourceWorkspaces.get(input.projectId)?.hasOpenFile(input.path)) {
            const abandoned = sourceModels.get(key!);
            if (abandoned?.model === model) abandoned.reference?.dispose();
            model.dispose();
          }
          return;
        }
        const entry = key ? sourceModels.get(key) : undefined;
        const view = monaco.editor.create(host.current, {
          model,
          automaticLayout: true,
          readOnly: input.readOnly,
          domReadOnly: input.readOnly,
          ariaLabel: input.label ?? input.path,
          fontFamily: "'SFMono-Regular', Menlo, Consolas, monospace",
          fontSize: 12,
          lineHeight: 20,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordBasedSuggestions: 'currentDocument',
          padding: { top: 10, bottom: 24 },
          glyphMargin: true,
          folding: true,
          renderWhitespace: 'selection',
          fixedOverflowWidgets: true,
          smoothScrolling: true,
          bracketPairColorization: { enabled: true },
          unicodeHighlight: { ambiguousCharacters: false },
          ...input.options,
        });
        viewRef.current = view;
        if (entry?.viewState) view.restoreViewState(entry.viewState);
        const changed = model.onDidChangeContent((event) => {
          if (applying.current) return;
          const text = model.getValue();
          const from = Math.min(...event.changes.map((change) => change.rangeOffset));
          const to = Math.max(...event.changes.map((change) => change.rangeOffset + change.rangeLength));
          const delta = event.changes.reduce((sum, change) => sum + change.text.length - change.rangeLength, 0);
          current.current.onChange?.(text, { from, to, insertedLength: to - from + delta });
          current.current.onDocumentChange?.(text, text !== current.current.savedContent);
        });
        const cursor = view.onDidChangeCursorPosition(({ position }) => current.current.onCursorChange?.(position.lineNumber, position.column));
        view.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => current.current.onSave?.());
        view.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyS, () => current.current.onSaveAll?.());
        current.current.onView?.(view);
        setReady((value) => value + 1);
        cleanup = () => {
          if (entry) entry.viewState = view.saveViewState();
          current.current.onView?.(null);
          changed.dispose();
          cursor.dispose();
          view.dispose();
          temporary?.dispose();
          viewRef.current = null;
        };
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [props.path, props.projectId]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.updateOptions({ readOnly: props.readOnly, domReadOnly: props.readOnly, ariaLabel: props.label ?? props.path, ...props.options });
    const model = view.getModel()!;
    monaco.editor.setModelLanguage(model, editorLanguage(props.path, props.language));
    if (model.getValue() !== props.content) {
      applying.current = true;
      try {
        // 磁盘刷新和冲突选入作为可撤销编辑，不能用 setValue 清空原生撤销栈。
        model.pushStackElement();
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: props.content }], () => null);
        model.pushStackElement();
      } finally {
        applying.current = false;
      }
    }
  }, [props.content, props.path, props.language, props.readOnly, props.label, props.options, ready]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !props.revealLine) return;
    const position = { lineNumber: props.revealLine, column: props.revealColumn ?? 1 };
    view.setPosition(position);
    view.revealPositionInCenterIfOutsideViewport(position);
  }, [props.revealLine, props.revealColumn, props.path, ready]);

  return (
    <div className="project-source-code-editor zeus-monaco-editor" style={{ height: '100%', minHeight: 0, minWidth: 0, overflow: 'hidden', position: 'relative' }}>
      <div ref={host} style={{ position: 'absolute', inset: 0 }} />
      {error ? (
        <div role="alert" className="source-editor-error">
          编辑器加载失败：{error}
        </div>
      ) : null}
    </div>
  );
});
