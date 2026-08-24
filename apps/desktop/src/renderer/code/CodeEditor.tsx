import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { indentWithTab } from '@codemirror/commands';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';
import { loadSourceLanguage } from './sourceLanguageRegistry.js';

export interface CodeEditorProps {
  path: string;
  language: string;
  content: string;
  readOnly: boolean;
  revealLine?: number | null;
  onChange(content: string): void;
  onCursorChange(line: number, column: number): void;
  onSave(): void;
  onSaveAll(): void;
}

export function CodeEditor(props: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | undefined>(undefined);
  const callbacksRef = useRef(props);
  callbacksRef.current = props;

  useEffect(() => {
    let cancelled = false;
    let view: EditorView | undefined;
    void loadLanguageExtension(props.language).then((languageExtension) => {
      if (cancelled || !hostRef.current) return;
      view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: callbacksRef.current.content,
          extensions: [
            basicSetup,
            languageExtension,
            syntaxHighlighting(classHighlighter),
            EditorState.readOnly.of(callbacksRef.current.readOnly),
            EditorView.editable.of(!callbacksRef.current.readOnly),
            keymap.of([
              indentWithTab,
              {
                key: 'Mod-s',
                run: () => {
                  callbacksRef.current.onSave();
                  return true;
                },
              },
              {
                key: 'Mod-Alt-s',
                run: () => {
                  callbacksRef.current.onSaveAll();
                  return true;
                },
              },
            ]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) callbacksRef.current.onChange(update.state.doc.toString());
              if (update.selectionSet || update.docChanged) {
                const head = update.state.selection.main.head;
                const line = update.state.doc.lineAt(head);
                callbacksRef.current.onCursorChange(line.number, head - line.from + 1);
              }
            }),
            EditorView.theme({
              '&': { blockSize: '100%', backgroundColor: 'var(--zeus-code-editor-bg)' },
              '.cm-scroller': { fontFamily: "'SFMono-Regular', 'SF Mono', Menlo, Consolas, monospace", fontSize: '12px', lineHeight: '1.58' },
              '.cm-content': { caretColor: 'var(--zeus-control-accent)', paddingBlock: '10px 32px' },
              '.cm-gutters': { backgroundColor: 'var(--zeus-code-editor-gutter)', border: '0', color: 'var(--zeus-control-subtle-text)' },
              '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--zeus-code-editor-active-line)' },
              '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--zeus-code-editor-selection) !important' },
              '.cm-focused': { outline: 'none' },
            }),
          ],
        }),
      });
      viewRef.current = view;
      revealRequestedLine(view, callbacksRef.current.revealLine);
    });
    return () => {
      cancelled = true;
      view?.destroy();
      if (viewRef.current === view) viewRef.current = undefined;
    };
  }, [props.language, props.path, props.readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === props.content) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.content } });
  }, [props.content]);

  useEffect(() => {
    revealRequestedLine(viewRef.current, props.revealLine);
  }, [props.revealLine]);

  return <div className="project-source-code-editor" ref={hostRef} aria-label={props.path} />;
}

async function loadLanguageExtension(language: string): Promise<Extension> {
  return (await loadSourceLanguage(language))?.extension ?? [];
}

function revealRequestedLine(view: EditorView | undefined, lineNumber: number | null | undefined): void {
  if (!view || !lineNumber || lineNumber < 1) return;
  const boundedLine = Math.min(lineNumber, view.state.doc.lines);
  const line = view.state.doc.line(boundedLine);
  view.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
  });
  view.focus();
}
