import { lazy, memo, Suspense } from 'react';

/** 长文本复用已有编辑器，查看交付物时才加载。 */
const CodeEditor = lazy(() => import('./CodeEditor.js').then((module) => ({ default: module.CodeEditor })));

/** 正式与阶段交付物共用全文可选、可复制的可视区域预览。 */
export const TextFilePreview = memo(function TextFilePreview(props: {
  /** 交付物身份，切换内容时清理旧视图。 */
  id: string;
  /** 文本查看区域的无障碍名称。 */
  title: string;
  /** 服务端已经校验的完整正文。 */
  content: string;
}) {
  return (
    <div className="text-file-preview" style={{ height: 'min(420px, 60vh)', minHeight: 120, minWidth: 0, overflow: 'hidden' }}>
      <Suspense fallback={<p role="status">{props.title}</p>}>
        <CodeEditor path={props.id} label={props.title} language={null} content={props.content} readOnly />
      </Suspense>
    </div>
  );
});
