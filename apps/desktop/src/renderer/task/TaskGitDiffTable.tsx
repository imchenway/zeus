import { lazy, Suspense, type ReactNode } from 'react';
import type { TaskGitFileDiff } from '../session/sessionTypes.js';
import type { DiffAnnotationLine } from '../code/CodeDiffView.js';

/** 重型代码视图仅在选中差异文件后加载。 */
const CodeDiffView = lazy(() => import('../code/CodeDiffView.js').then((module) => ({ default: module.CodeDiffView })));

/** 交付与会话审核共用左右差异；审核可在原始行号处补充操作及评论。 */
export function TaskGitDiffTable(props: {
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
  if (props.diff.hunks.length === 0) {
    return <p className="task-git-review-empty">{props.zh ? '文件已经变化，但没有可显示的文本内容，可能是二进制文件或仅文件属性变化。' : 'The file changed, but no text content is available; it may be binary or metadata-only.'}</p>;
  }
  return (
    <div className="task-git-review-diff-table code-diff-host">
      <Suspense fallback={<p role="status">{props.zh ? '正在打开差异…' : 'Opening diff…'}</p>}>
        <CodeDiffView
          file={props.diff}
          label={props.zh ? '左右代码差异' : 'Side-by-side code diff'}
          annotationLines={props.annotationLines}
          focusAnnotation={props.focusAnnotation}
          renderLineNumber={props.renderLineNumber}
          renderLineComments={props.renderLineComments}
        />
      </Suspense>
    </div>
  );
}
