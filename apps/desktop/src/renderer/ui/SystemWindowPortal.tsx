import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { closeDocumentLayer } from './nativeCloseLayer.js';
import { WindowDocumentContext, systemWindowDocuments } from './windowDocument.js';
import './systemWindow.css';
import { installIconTooltips } from '../../preload/iconTooltip.js';
import { installMarkdownListInput } from '../../preload/markdownListInput.js';

/** 仅已迁移的工作窗口可请求主进程白名单。 */
export type SystemWindowKind = 'git-push' | 'git-update' | 'git-commit' | 'task-push' | 'file-preview';

/** 原生控制按钮由系统绘制，内容区只提供标题和拖动区域。 */
export function SystemWindowTitleBar({ title }: { title: string }) {
  return (
    <div className="zeus-system-window-titlebar" aria-hidden="true">
      <span>{title}</span>
    </div>
  );
}

/** 原窗口继续管理表单和授权，系统窗口只承载同源界面。 */
export function SystemWindowPortal(props: { kind: SystemWindowKind; title: string; activation?: unknown; onClose?: () => void; children: ReactNode }) {
  /** 原生窗口名称与所属文档一起更新，恢复时内容和显示请求使用同一个窗口。 */
  const [target, setTarget] = useState<{ name: string; document: Document } | null>(null);
  /** 创建失败必须明确显示，不把网页遮罩伪装成系统窗口。 */
  const [error, setError] = useState('');
  /** 事件监听始终使用最新的关闭回调。 */
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useLayoutEffect(() => {
    /** 会话隐藏后重新显示时，重新分配原生窗口身份。 */
    const name = `zeus-system:${props.kind}:${crypto.randomUUID()}`;
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
    /** 门户事件来自子文档，文件复制必须在同一文档接收。 */
    const disposeFilePathActions = installFilePathActions(targetDocument);
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
    setError('');
    setTarget({ name, document: targetDocument });
    return () => {
      setTarget(null);
      observer.disconnect();
      disposeTooltips();
      disposeFilePathActions();
      disposeListInput();
      unsubscribe();
      systemWindowDocuments.delete(targetDocument);
      void bridge.updateSystemWindow(name, 'close').catch(() => undefined);
    };
  }, [props.kind]);
  useLayoutEffect(() => {
    if (!target || error || !systemWindowDocuments.has(target.document)) return;
    /** 内容提交到该文档后再显示；已离开的窗口不能回写显示错误。 */
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      void window.zeus?.updateSystemWindow(target.name, 'show').catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '系统窗口无法显示。');
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [target, error, props.activation]);
  useLayoutEffect(() => {
    if (target) target.document.title = props.title;
  }, [target, props.title]);
  if (error)
    return (
      <div role="alert" className="system-window-error">
        {error}
        <Button unstyled type="button" onClick={() => closeRef.current?.()}>
          关闭
        </Button>
      </div>
    );
  // 子树按原生窗口身份挂载，使门户、焦点和关闭操作使用新文档。
  return target ? (
    <WindowDocumentContext.Provider key={target.name} value={target.document}>
      {props.children}
    </WindowDocumentContext.Provider>
  ) : null;
}
import { installFilePathActions } from './filePathActions.js';
import { Button } from './Button.js';
