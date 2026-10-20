import { createContext, useContext, useState } from 'react';

/** 系统窗口内的门户、菜单和焦点使用同一个文档。 */
export const WindowDocumentContext = createContext<Document | null>(null);
/** 活动系统窗口供全局错误框和模型接入流程选择当前显示位置。 */
export const systemWindowDocuments = new Set<Document>();

/** 工作区只有一个任务推送表单，重复入口唤回它并保留未提交内容。 */
export function focusTaskPushWindow(): boolean {
  /** 窗口身份由受信门户登记，不从页面文本推断。 */
  const target = [...systemWindowDocuments].find((candidate) => candidate.body.dataset.systemWindow === 'task-push');
  if (!target?.defaultView || !window.zeus?.updateSystemWindow) return false;
  void window.zeus.updateSystemWindow(target.defaultView.name, 'show').catch(() => undefined);
  return true;
}

/** 挂载时固定所属窗口，后续切换焦点不会移动已有表单。 */
export function useWindowDocument(): Document {
  /** 显式的子窗口上下文优先于全局焦点。 */
  const context = useContext(WindowDocumentContext);
  /** 从系统窗口触发的全局弹层仍留在该窗口。 */
  const [owner] = useState(() => context ?? [...systemWindowDocuments].find((candidate) => candidate.hasFocus()) ?? document);
  return owner;
}
