import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { subscribeProjectGitRefresh } from '../git/projectGitWorkbenchState.js';
import { reportApplicationError } from '../ui/ApplicationErrorDialog.js';
import { Button } from '../ui/Button.js';
import { copyText } from '../ui/clipboard.js';
import { CodeEditor, type CodeEditorProps } from './CodeEditor.js';
import { DiffChangeNavigation } from './DiffReviewToolbar.js';
import { blameDecorations } from './blameDecorations.js';
import { sourceGitGutter, type SourceGitComparison, type SourceGitPreview } from './sourceGitGutter.js';
import { useGitBlame } from './useGitBlame.js';
import './blameGutter.css';
import './codeDiffView.css';

/** 全文件差异仅在用户打开对比时加载。 */
const SourceGitDiffDialog = lazy(() => import('./SourceGitDiffDialog.js').then((module) => ({ default: module.SourceGitDiffDialog })));

/** 弹窗的基线和草稿绑定到当前工作树的文件。 */
type SourceGitReview = SourceGitComparison & { projectId: string; path: string; baseline: string };

/** 项目源码编辑器显示相对 HEAD 的草稿变更；逐行归属仍对应已保存内容。 */
export function ProjectSourceEditor({ projectId, revision, dirty, revertDisabled, zh, ...editor }: CodeEditorProps & { projectId: string; revision: string; dirty: boolean; revertDisabled: boolean; zh: boolean }) {
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
  /** 同一时刻至多有一个 CodeMirror 区块挂载 React 工具栏。 */
  const [gitPreview, setGitPreview] = useState<SourceGitPreview | null>(null);
  const [comparison, setComparison] = useState<SourceGitReview | null>(null);
  /** 保存和外部修改可在工具栏打开时发生，恢复按钮总是检查最新状态。 */
  const restoreBlocked = useRef(revertDisabled);
  restoreBlocked.current = revertDisabled;
  /** 基线或文件变化时替换扩展，草稿更新由 CodeMirror 接收。 */
  const gitGutter = useMemo(
    () =>
      sourceGitGutter(gitBase, zh, {
        mount: setGitPreview,
        unmount: (host) => setGitPreview((current) => (current?.host === host ? null : current)),
        canRestore: () => !restoreBlocked.current,
        compare: (input) => {
          if (gitBase !== null) setComparison({ ...input, projectId, path, baseline: gitBase });
        },
      }),
    [gitBase, path, projectId, zh],
  );
  /** 比较使用打开时的两端，工作树切换或正文更新后关闭旧快照。 */
  const currentComparison =
    comparison?.projectId === projectId && comparison.path === path && comparison.baseline === gitBase && (typeof editor.content === 'string' ? comparison.draft.toString() === editor.content : comparison.draft.eq(editor.content))
      ? comparison
      : null;
  useEffect(() => {
    if (comparison && !currentComparison) setComparison(null);
  }, [comparison, currentComparison]);
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
        if (event.currentTarget.contains(event.target) && !event.currentTarget.contains(event.relatedTarget)) refreshGitRef.current?.();
      }}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, minWidth: 0 }}
    >
      <CodeEditor {...editor} extensions={extensions} blameLines={!dirty ? blame?.lines : undefined} locale={locale} />
      {gitPreview ? createPortal(<SourceGitChangePanel preview={gitPreview} revertDisabled={revertDisabled} zh={zh} />, gitPreview.host) : null}
      {currentComparison ? (
        <Suspense fallback={null}>
          <SourceGitDiffDialog {...currentComparison} before={currentComparison.baseline} zh={zh} onClose={() => setComparison(null)} />
        </Suspense>
      ) : null}
    </div>
  );
}

/** 行内工具栏使用现有差异控件，原文可以直接选择和复制。 */
function SourceGitChangePanel({ preview, revertDisabled, zh }: { preview: SourceGitPreview; revertDisabled: boolean; zh: boolean }) {
  const [copied, setCopied] = useState(false);
  /** 打开或跳转后将键盘焦点移入当前操作组。 */
  useLayoutEffect(() => {
    if (preview.focusOnMount) preview.host.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [preview]);

  /** 复制精确的 HEAD 原文，失败沿用共享错误提示。 */
  async function copyBefore() {
    if (preview.before === null) return;
    if (await copyText(preview.before)) setCopied(true);
    else reportApplicationError(new Error(zh ? '复制失败，请重试。' : 'Could not copy. Please try again.'), { language: zh ? 'zh-CN' : 'en' });
  }

  /** 仅为配对修改加字词背景，纯删除使用一层连续底色。 */
  const original: ReactNode[] = [];
  if (preview.before !== null) {
    let position = 0;
    for (const [from, to] of preview.words) {
      original.push(preview.before.slice(position, from), <mark key={from}>{preview.before.slice(from, to)}</mark>);
      position = to;
    }
    original.push(preview.before.slice(position) || (original.length ? '' : '\n'));
  }
  const closeLabel = zh ? '关闭差异预览' : 'Close change preview';
  const restoreLabel = zh ? '恢复此处改动，可撤销；保存后写入文件' : 'Restore this change; save to write the file';
  return (
    <section
      className={'source-git-preview ' + preview.tone}
      aria-label={zh ? '此处差异' : 'Change preview'}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        preview.close();
      }}
    >
      <div className="diff-review-toolbar source-git-preview-toolbar">
        <DiffChangeNavigation zh={zh} current={preview.index} count={preview.count} onNavigate={preview.navigate} />
        {preview.before !== null ? <span className="source-git-preview-label">{zh ? '改前 · HEAD' : 'Before · HEAD'}</span> : null}
        <div className="source-git-preview-actions">
          {preview.before !== null ? (
            <Button unstyled type="button" onClick={copyBefore}>
              <span aria-live="polite">{copied ? (zh ? '已复制' : 'Copied') : zh ? '复制原文' : 'Copy original'}</span>
            </Button>
          ) : null}
          <Button unstyled type="button" onClick={preview.compare}>
            {zh ? '完整差异' : 'Full diff'}
          </Button>
          <Button unstyled type="button" title={restoreLabel} onClick={preview.restore} disabled={revertDisabled}>
            <span className="code-diff-revert-icon" aria-hidden="true" />
            {zh ? '恢复此处' : 'Restore change'}
          </Button>
          <Button unstyled type="button" aria-label={closeLabel} title={closeLabel} onClick={preview.close}>
            <XIcon size={16} aria-hidden="true" />
          </Button>
        </div>
      </div>
      {preview.before !== null ? (
        <pre className="source-git-original" data-zeus-selectable="text">
          <code>{original}</code>
        </pre>
      ) : null}
    </section>
  );
}
