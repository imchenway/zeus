import { useMemo, useState } from 'react';
import type { FileReviewDiff } from '@zeus/shared';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { CodeDiffView } from './CodeDiffView.js';
import { FilePreviewDataContext } from './FilePreview.js';
import { fullFileDiff } from './fullFileDiff.js';
import type { SourceGitComparison } from './sourceGitGutter.js';

/** 在已有差异视图中比较 HEAD 与内存草稿，打开时定位原来的差异块。 */
export function SourceGitDiffDialog({ path, before, draft, changes, revealLine, zh, onClose }: SourceGitComparison & { path: string; before: string; zh: boolean; onClose(): void }) {
  const [full, setFull] = useState(true);
  const [unified, setUnified] = useState(false);
  /** 两份正文来自点击时的同一编辑器，比较无需再次读取磁盘。 */
  const { file, complete } = useMemo(() => {
    const versions = [
      { kind: 'text' as const, content: before },
      { kind: 'text' as const, content: draft.toString() },
    ];
    const left = before.split('\n');
    const file: FileReviewDiff = { oldPath: path, newPath: path, changeType: 'modified', addedLines: 0, deletedLines: 0, hunks: [] };
    /** 用已计算的块构造原始行，重复行和末尾删除的定位与色块一致。 */
    for (const change of changes) {
      const oldStart = change.beforeLine - Number(!change.removed);
      const newStart = change.afterLine - Number(!change.added);
      file.addedLines += change.added;
      file.deletedLines += change.removed;
      file.hunks.push({
        header: `@@ -${oldStart},${change.removed} +${newStart},${change.added} @@`,
        oldStart,
        newStart,
        oldLines: change.removed,
        newLines: change.added,
        lines: [
          ...Array.from({ length: change.removed }, (_, offset) => ({ type: 'deletion' as const, content: left[change.beforeLine + offset - 1]!, oldLineNumber: change.beforeLine + offset, newLineNumber: null })),
          ...Array.from({ length: change.added }, (_, offset) => ({ type: 'addition' as const, content: draft.line(change.afterLine + offset).text, oldLineNumber: null, newLineNumber: change.afterLine + offset })),
        ],
      });
    }
    return { file, complete: fullFileDiff(file, versions) };
  }, [before, changes, draft, path]);
  const label = zh ? '完整差异' : 'Full diff';
  return (
    <ModalPortal rootClassName="project-source-modal-root" backdropClassName="project-source-modal-backdrop" onDismiss={onClose} role="dialog" aria-label={label}>
      <section className="project-source-comparison source-git-comparison" data-modal-surface="dialog">
        <header>
          <strong title={path}>{path}</strong>
          <Button unstyled type="button" onClick={onClose}>
            {zh ? '关闭' : 'Close'}
          </Button>
        </header>
        {complete ? (
          <FilePreviewDataContext.Provider value={{ items: null, full, zh, unified, toolbarTarget: null, onFullChange: setFull, onUnifiedChange: setUnified }}>
            <CodeDiffView file={file} completeFile={complete} revealLine={revealLine} label={label} resizable />
          </FilePreviewDataContext.Provider>
        ) : (
          <p role="status">{zh ? '差异与文件内容不一致，请关闭后重试。' : 'The diff no longer matches the file contents. Close and reopen it.'}</p>
        )}
      </section>
    </ModalPortal>
  );
}
