import { lazy, memo, Suspense } from 'react';
import type { FileFindGroup, FileFindSide } from './fileFind.js';

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
  /** 使用所属页面的查找文案。 */
  zh: boolean;
  /** 从阅读模式打开原文后聚焦查找。 */
  searchRequest?: number;
  /** 比对交付物修订时只显示一个查找栏。 */
  findGroup?: FileFindGroup;
  /** 来源与当前正文的匹配记录分别保留。 */
  findSide?: FileFindSide;
}) {
  return (
    <div className="text-file-preview" style={{ height: 'min(420px, 60vh)', minHeight: 120, minWidth: 0, overflow: 'hidden' }}>
      <Suspense fallback={null}>
        <CodeEditor path={props.id} label={props.title} locale={props.zh ? 'zh-CN' : 'en-US'} language={null} content={props.content} searchRequest={props.searchRequest} findGroup={props.findGroup} findSide={props.findSide} readOnly />
      </Suspense>
    </div>
  );
});
