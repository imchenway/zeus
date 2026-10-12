import { useMemo } from 'react';
import { CodeEditor, type CodeEditorProps } from './CodeEditor.js';
import { blameDecorations } from './blameDecorations.js';
import { useGitBlame } from './useGitBlame.js';
import './blameGutter.css';

/** 项目源码编辑器接入逐行归属；未保存草稿不展示与磁盘不一致的提交信息。 */
export function ProjectSourceEditor({ projectId, revision, dirty, zh, ...editor }: CodeEditorProps & { projectId: string; revision: string; dirty: boolean; zh: boolean }) {
  /** 归属信息自动加载，工具行移除后不再持有显示开关。 */
  const blame = useGitBlame({ projectId, filePath: editor.path, revision });
  /** 日期继续使用当前界面语言。 */
  const locale = zh ? 'zh-CN' : 'en-US';
  /** 未保存的内容隐藏磁盘归属，不改变原有编辑能力。 */
  const extensions = useMemo(() => [editor.extensions ?? [], !dirty && blame ? blameDecorations(blame.lines, { locale }) : []], [editor.extensions, dirty, blame, locale]);
  return (
    <div className="project-source-editor-with-blame" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 }}>
      <CodeEditor {...editor} extensions={extensions} />
    </div>
  );
}
