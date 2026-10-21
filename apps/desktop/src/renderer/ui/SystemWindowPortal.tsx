import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { closeDocumentLayer } from './nativeCloseLayer.js';
import { WindowDocumentContext, systemWindowDocuments } from './windowDocument.js';
import './systemWindow.css';
import { installIconTooltips } from '../../preload/iconTooltip.js';
import { installMarkdownListInput } from '../../preload/markdownListInput.js';

/** 仅已迁移的工作窗口可请求主进程白名单。 */
export type SystemWindowKind = 'git-push' | 'git-commit' | 'task-push' | 'file-preview';

/** 原窗口继续管理表单和授权，系统窗口只承载同源界面。 */
export function SystemWindowPortal(props: { kind: SystemWindowKind; title: string; activation?: unknown; onClose?: () => void; children: ReactNode }) {
  /** 窗口就绪前不挂载业务子树，避免重复读取和资源泄漏。 */
  const [target, setTarget] = useState<Document | null>(null);
  /** 创建失败必须明确显示，不把网页遮罩伪装成系统窗口。 */
  const [error, setError] = useState('');
  /** 重复点击入口时只唤回本组件创建的窗口。 */
  const windowName = useRef('');
  /** 事件监听始终使用最新的关闭回调。 */
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useLayoutEffect(() => {
    /** 每次挂载拥有唯一窗口，关闭和重开不复用过期 DOM。 */
    const name = `zeus-system:${props.kind}:${crypto.randomUUID()}`;
    windowName.current = name;
    /** 桌面桥接仅用于窗口生命周期，业务调用保持原授权。 */
    const bridge = window.zeus;
    if (!bridge?.updateSystemWindow || !bridge.onSystemWindowCloseRequest) {
      setError('系统窗口服务尚未就绪，请更新并重启 Zeus。');
      return;
    }
    /** about:blank 保留同源 DOM；主进程只允许固定名称与空白地址。 */
    const child = window.open('about:blank', name);
    if (!child) {
      setError('无法打开系统窗口，请关闭多余窗口后重试。');
      return;
    }
    /** 子文档继承主题和样式，不执行复制过来的脚本。 */
    const targetDocument = child.document;
    targetDocument.title = props.title;
    /** 绝对基址使打包和开发样式中的相对资源都能解析。 */
    const base = targetDocument.createElement('base');
    base.href = document.baseURI;
    targetDocument.head.append(base);
    /** 只复制样式节点，异步加载样式和开发热更新也保持同步。 */
    const styles = new Map<Element, Element>();
    /** 主文档主题变化不重建业务 DOM。 */
    const sync = (): void => {
      for (const attribute of [...targetDocument.documentElement.attributes]) targetDocument.documentElement.removeAttribute(attribute.name);
      for (const attribute of [...document.documentElement.attributes]) targetDocument.documentElement.setAttribute(attribute.name, attribute.value);
      targetDocument.body.dataset.surface = 'system-window';
      targetDocument.body.dataset.systemWindow = props.kind;
      for (const [source, copy] of styles) {
        if (!source.isConnected) {
          copy.remove();
          styles.delete(source);
        }
      }
      for (const source of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
        /** 未变化样式保持原节点，避免窗口闪白。 */
        const previous = styles.get(source);
        if (previous?.outerHTML === source.outerHTML) continue;
        /** 只接受来自主应用 head 的样式。 */
        const copy = source.cloneNode(true) as Element;
        if (previous) previous.replaceWith(copy);
        else targetDocument.head.append(copy);
        styles.set(source, copy);
      }
    };
    sync();
    /** 工具提示复用主应用管理器，并监听子窗口自己的键盘与鼠标事件。 */
    const disposeTooltips = installIconTooltips(targetDocument);
    /** 同源系统窗口使用自己的原生编辑与撤销历史。 */
    const disposeListInput = installMarkdownListInput(targetDocument);
    /** 动态主题与懒加载组件样式继续使用原应用规则。 */
    const observer = new MutationObserver(sync);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
    observer.observe(document.documentElement, { attributes: true });
    systemWindowDocuments.add(targetDocument);
    /** 系统关闭按钮和 Cmd+W 先走该文档最上层，提交期间保持原关闭保护。 */
    const unsubscribe = bridge.onSystemWindowCloseRequest((requested) => {
      if (requested === name) closeDocumentLayer(targetDocument);
    });
    setTarget(targetDocument);
    /** 等首帧挂载后展示，避免先看到无样式空白页。 */
    const frame = window.requestAnimationFrame(() => {
      void bridge.updateSystemWindow(name, 'show').catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '系统窗口无法显示。'));
    });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      disposeTooltips();
      disposeListInput();
      unsubscribe();
      systemWindowDocuments.delete(targetDocument);
      void bridge.updateSystemWindow(name, 'close').catch(() => undefined);
    };
  }, [props.kind]);
  useLayoutEffect(() => {
    if (target) void window.zeus?.updateSystemWindow(windowName.current, 'show').catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '系统窗口无法显示。'));
  }, [props.activation]);
  useLayoutEffect(() => {
    if (target) target.title = props.title;
  }, [target, props.title]);
  if (error)
    return (
      <div role="alert" className="system-window-error">
        {error}
        <button type="button" onClick={() => closeRef.current?.()}>
          关闭
        </button>
      </div>
    );
  return target ? <WindowDocumentContext.Provider value={target}>{props.children}</WindowDocumentContext.Provider> : null;
}
