import { useMemo } from 'react';
import { CodeEditor, type CodeEditorProps } from './CodeEditor.js';
import { blameDecorations } from './blameDecorations.js';
import { useGitBlame } from './useGitBlame.js';
import './blameGutter.css';
import { useCodeReadingPreferences } from './codeReadingOptions.js';

/** 项目源码编辑器接入逐行归属；未保存草稿不展示与磁盘不一致的提交信息。 */
export function ProjectSourceEditor({ projectId, revision, dirty, zh, ...editor }: CodeEditorProps & { projectId: string; revision: string; dirty: boolean; zh: boolean }) {
  /** 归属自动读取，显示状态由共享阅读菜单控制。 */
  const blame = useGitBlame({ projectId, filePath: editor.path, revision });
  /** 行尾和逐行侧栏共用开关，避免关闭后仍显示作者。 */
  const reading = useCodeReadingPreferences();
  /** 日期继续使用当前界面语言。 */
  const locale = zh ? 'zh-CN' : 'en-US';
  /** 未保存的内容隐藏磁盘归属，不改变原有编辑能力。 */
  const extensions = useMemo(() => [editor.extensions ?? [], reading.blame && !dirty && blame ? blameDecorations(blame.lines, { locale }) : []], [editor.extensions, dirty, blame, locale, reading.blame]);
  return (
    <div className="project-source-editor-with-blame" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 }}>
      <CodeEditor {...editor} extensions={extensions} blameLines={!dirty ? blame?.lines : undefined} locale={locale} />
    </div>
  );
}
