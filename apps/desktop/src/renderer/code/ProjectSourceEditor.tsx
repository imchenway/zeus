import { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeProjectGitRefresh } from '../git/projectGitWorkbenchState.js';
import { CodeEditor, type CodeEditorProps } from './CodeEditor.js';
import { blameDecorations } from './blameDecorations.js';
import { sourceGitGutter } from './sourceGitGutter.js';
import { useGitBlame } from './useGitBlame.js';
import './blameGutter.css';

/** 项目源码编辑器显示相对 HEAD 的草稿变更；逐行归属仍对应已保存内容。 */
export function ProjectSourceEditor({ projectId, revision, dirty, zh, ...editor }: CodeEditorProps & { projectId: string; revision: string; dirty: boolean; zh: boolean }) {
  /** 路径与工作树共同标识正在显示的 Git 基线。 */
  const { path, readOnly } = editor;
  /** 切换文件时仅使用匹配当前项目和路径的结果。 */
  const [baseline, setBaseline] = useState<{ projectId: string; path: string; content: string | null } | null>(null);
  /** 从内置终端等同窗口区域返回编辑器时也重新确认 HEAD。 */
  const refreshGitRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    /** Git 基线与保存状态独立，逐字输入只更新编辑器内的差异。 */
    const read = window.zeus?.readProjectSourceGitBaseline;
    if (!read || readOnly) return;
    /** 文件切换或新请求开始后丢弃旧结果。 */
    let request = 0;
    /** 外部 Git 刷新和编辑器重新聚焦共用基线读取。 */
    const refresh = () => {
      /** 本次读取的顺序用于防止旧 HEAD 覆盖新结果。 */
      const current = ++request;
      void read({ projectId, relativePath: path })
        .catch(() => null)
        .then((content) => {
          if (current === request) setBaseline({ projectId, path, content });
        });
    };
    refreshGitRef.current = refresh;
    refresh();
    /** 与工作台共用 Git 变更及系统窗口恢复通知。 */
    const unsubscribe = subscribeProjectGitRefresh(projectId, refresh);
    return () => {
      request++;
      refreshGitRef.current = null;
      unsubscribe();
    };
  }, [path, projectId, readOnly]);

  /** 空字符串表示已暂存的新文件，仍计算新增行。 */
  const gitBase = !readOnly && baseline?.projectId === projectId && baseline.path === path ? baseline.content : null;
  /** 基线和语言变化时更新 Git 扩展，草稿更新由 CodeMirror 接收。 */
  const gitGutter = useMemo(() => sourceGitGutter(gitBase, zh), [gitBase, zh]);
  /** 归属自动读取，空记录由共享展示规则过滤。 */
  const blame = useGitBlame({ projectId, filePath: path, revision });
  /** 日期继续使用当前界面语言。 */
  const locale = zh ? 'zh-CN' : 'en-US';
  /** 未保存的内容隐藏磁盘归属，不改变原有编辑能力。 */
  const extensions = useMemo(() => [editor.extensions ?? [], gitGutter, !dirty && blame ? blameDecorations(blame.lines, { locale }) : []], [editor.extensions, gitGutter, dirty, blame, locale]);
  return (
    <div
      className="project-source-editor-with-blame"
      onFocus={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) refreshGitRef.current?.();
      }}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 }}
    >
      <CodeEditor {...editor} extensions={extensions} blameLines={!dirty ? blame?.lines : undefined} locale={locale} />
    </div>
  );
}
