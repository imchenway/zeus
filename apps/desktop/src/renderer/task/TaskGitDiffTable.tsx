import { FilePreview } from '../code/FilePreview.js';
import type { FilePreviewRequest } from '@zeus/shared';
import { lazy, Suspense, type ReactNode } from 'react';
import type { TaskGitFileDiff } from '../session/sessionTypes.js';
import type { DiffAnnotationLine } from '../code/CodeDiffView.js';
import type { FileStatus } from '../code/fileStatus.js';

/** 重型代码视图仅在选中差异文件后加载。 */
const CodeDiffView = lazy(() => import('../code/CodeDiffView.js').then((module) => ({ default: module.CodeDiffView })));

/** 交付与会话审核共用差异；新增、删除只显示有效侧，评论沿用原始行号。 */
function TaskGitTextDiffTable(props: {
  /** 文件名状态由工作区提供，正文仍按补丁类型展示。 */
  fileStatus?: FileStatus;
  /** 文件预览使用业务身份，而非补丁文本推断文件内容。 */
  previewRequest?: FilePreviewRequest;
  /** 工作区快照刷新后重新读取。 */
  revision?: string | number;
  /** 当前文件保存后刷新审核页的文件状态。 */
  onSaved?: () => void | Promise<void>;
  /** 已按补丁片段解析的文件差异。 */
  diff: TaskGitFileDiff | null;
  /** 区分尚未选择文件与当前文件没有文本差异。 */
  hasSelection: boolean;
  /** 沿用所在页面的中英文文案。 */
  zh: boolean;
  /** 自定义有效行号的操作；空白补位和片段头不产生可操作行。 */
  renderLineNumber?: (line: number, side: 'left' | 'right') => ReactNode;
  /** 评论排在对应侧的代码行下方，左右行始终共用同一行高。 */
  annotationLines?: DiffAnnotationLine[];
  /** 新建或正在编辑的评论位置。 */
  focusAnnotation?: DiffAnnotationLine;
  /** 仅对实际有评论的行渲染正文。 */
  renderLineComments?: (line: number, side: 'left' | 'right') => ReactNode;
}) {
  if (!props.diff) {
    return (
      <p className="task-git-review-empty">{props.hasSelection ? (props.zh ? '该文件暂无可显示的文本差异。' : 'No text diff is available for this file.') : props.zh ? '请选择文件查看代码差异。' : 'Select a file to view its code diff.'}</p>
    );
  }

  return (
    <div className="task-git-review-diff-table code-diff-host">
      <Suspense fallback={null}>
        <CodeDiffView
          file={props.diff}
          singleSide={props.diff.changeType === 'added' ? 'right' : props.diff.changeType === 'deleted' ? 'left' : undefined}
          label={
            props.diff.changeType === 'added' ? (props.zh ? '新增文件代码' : 'Added file code') : props.diff.changeType === 'deleted' ? (props.zh ? '删除文件代码' : 'Deleted file code') : props.zh ? '左右代码差异' : 'Side-by-side code diff'
          }
          annotationLines={props.annotationLines}
          focusAnnotation={props.focusAnnotation}
          renderLineNumber={props.renderLineNumber}
          renderLineComments={props.renderLineComments}
        />
      </Suspense>
    </div>
  );
}

/** 所有任务差异入口通过共享预览选择媒体或原有文字与评论界面。 */
export function TaskGitDiffTable(props: Parameters<typeof TaskGitTextDiffTable>[0]) {
  return props.previewRequest ? (
    <FilePreview request={props.previewRequest} revision={props.revision} onSaved={props.onSaved} zh={props.zh} fileStatus={props.fileStatus ?? props.diff?.changeType}>
      {props.diff ? <TaskGitTextDiffTable {...props} /> : null}
    </FilePreview>
  ) : (
    <TaskGitTextDiffTable {...props} />
  );
}
