import { useMemo } from 'react';
import { CodeEditor, type CodeEditorProps } from './CodeEditor.js';
import { blameDecorations } from './blameDecorations.js';
import { GitBlameToolbar } from './GitBlameToolbar.js';
import { useGitBlame } from './useGitBlame.js';

/** 项目源码编辑器接入逐行归属；未保存草稿不展示与磁盘不一致的提交信息。 */
export function ProjectSourceEditor({ projectId, revision, dirty, zh, ...editor }: CodeEditorProps & { projectId: string; revision: string; dirty: boolean; zh: boolean }) {
  const blame = useGitBlame({ projectId, filePath: editor.path, revision });
  const locale = zh ? 'zh-CN' : 'en-US';
  const extensions = useMemo(() => [editor.extensions ?? [], !dirty && blame.enabled && blame.blame ? blameDecorations(blame.blame.lines, { locale }) : []], [editor.extensions, dirty, blame.enabled, blame.blame, locale]);
  return (
    <div className="project-source-editor-with-blame" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 }}>
      <GitBlameToolbar
        blame={blame}
        paused={dirty ? (zh ? '保存后显示当前行归属' : 'Save to show current-line blame') : undefined}
        labels={{
          locale,
          show: zh ? '显示 Git blame' : 'Show Git blame',
          hide: zh ? '隐藏 Git blame' : 'Hide Git blame',
          loading: zh ? '正在加载 Git blame…' : 'Loading Git blame…',
          unavailable: zh ? 'Git blame 暂不可用' : 'Git blame unavailable',
          retry: zh ? '重试' : 'Retry',
        }}
      />
      <CodeEditor {...editor} extensions={extensions} />
    </div>
  );
}
