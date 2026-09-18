import { useEffect, useState } from 'react';
import { CodeEditor, type CodeEditorProps } from './CodeEditor.js';
import { monaco } from './monacoRuntime.js';
import { hasProjectLanguage, updateSourceDiagnostics } from './sourceLanguageProviders.js';
import { attachSourceConflicts } from './monacoSourceDecorations.js';
import { GitBlameToolbar } from './GitBlameToolbar.js';
import { useGitBlame } from './useGitBlame.js';

/** 项目语言能力、冲突操作和 Git 归属随同一模型更新。 */
export function ProjectSourceEditor({
  projectId,
  revision,
  dirty,
  zh,
  onCompareConflict,
  ...editor
}: CodeEditorProps & { projectId: string; revision: string; dirty: boolean; zh: boolean; onCompareConflict(current: string, incoming: string): void }) {
  const blame = useGitBlame({ projectId, filePath: editor.path, revision, suspended: dirty });
  const [view, setView] = useState<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!view) return;
    const model = view.getModel();
    if (!model) return;
    if (!hasProjectLanguage(model)) {
      setStatus(zh ? '语法高亮 · 当前语言暂未接入项目分析' : 'Syntax highlighting · Project analysis is not available for this language');
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const analyze = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void updateSourceDiagnostics(model).then((message) => {
          if (active && message) setStatus('TypeScript · ' + message);
        });
      }, 450);
    };
    setStatus(zh ? '正在分析项目…' : 'Analyzing project…');
    analyze();
    const changed = model.onDidChangeContent(analyze);
    const external = window.zeus?.onProjectSourceEvent((event) => {
      if (event.projectId === projectId) analyze();
    });
    return () => {
      active = false;
      clearTimeout(timer);
      changed.dispose();
      external?.();
    };
  }, [view, projectId, zh]);
  useEffect(() => {
    if (!view) return;
    return attachSourceConflicts(view, zh, onCompareConflict).dispose;
  }, [view, zh, onCompareConflict]);
  useEffect(() => {
    if (!view) return;
    const decorations = view.createDecorationsCollection();
    const update = () => {
      const model = view.getModel(),
        position = view.getPosition();
      const line = !dirty && position ? blame.blame?.lines.find((item) => item.line === position.lineNumber) : undefined;
      if (!model || !line || !position || !view.hasTextFocus() || !view.getSelection()?.isEmpty()) {
        decorations.clear();
        return;
      }
      const column = model.getLineMaxColumn(position.lineNumber);
      decorations.set([
        {
          range: new monaco.Range(position.lineNumber, column, position.lineNumber, column),
          options: {
            showIfCollapsed: true,
            after: { content: '  ' + (line.author || 'Unknown') + ' · ' + (line.subject || line.shortHash), inlineClassName: 'source-blame-inline', cursorStops: monaco.editor.InjectedTextCursorStops.None },
            hoverMessage: { value: line.shortHash + ' · ' + line.author + '\n\n' + line.subject, isTrusted: false },
          },
        },
      ]);
    };
    update();
    const subscriptions = [view.onDidChangeCursorSelection(update), view.onDidFocusEditorText(update), view.onDidBlurEditorText(update), view.onDidChangeModelContent(() => decorations.clear())];
    return () => {
      subscriptions.forEach((item) => item.dispose());
      decorations.clear();
    };
  }, [view, dirty, blame.blame]);
  return (
    <div className="project-source-editor-with-blame" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 }}>
      <GitBlameToolbar
        blame={blame}
        paused={dirty ? (zh ? '保存后显示当前行归属' : 'Save to show current-line blame') : undefined}
        labels={{
          locale: zh ? 'zh-CN' : 'en-US',
          loading: zh ? '正在加载 Git blame…' : 'Loading Git blame…',
          unavailable: zh ? 'Git blame 暂不可用' : 'Git blame unavailable',
          retry: zh ? '重试' : 'Retry',
        }}
      />
      <div className="source-language-status" role="status">
        {status}
      </div>
      <CodeEditor {...editor} projectId={projectId} onView={setView} />
    </div>
  );
}
