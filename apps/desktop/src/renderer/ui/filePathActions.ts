import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MenuSurface } from './MenuSurface.js';
import { copyText } from './clipboard.js';
import { reportApplicationError } from './ApplicationErrorDialog.js';

/** 已知根目录时生成可复制的完整路径，兼容 Windows、UNC 与 POSIX 路径。 */
export function displayedFilePath(path: string, root?: string): string {
  if (!root || /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(path)) return path;
  /** 路径沿用真实根目录的分隔符。 */
  const separator = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/u, '')}${separator}${path.replace(/[\\/]/gu, separator)}`;
}

/** 文件行、标题和标签共用复制入口；原生编辑菜单仍优先复制用户的文字选区。 */
export function installFilePathActions(document: Document): () => void {
  /** 同源系统窗口使用所属文档的事件和构造器。 */
  const view = document.defaultView! as Window & typeof globalThis;
  /** 右键菜单只存活到本次选择、取消或窗口关闭。 */
  let menu: HTMLElement | null = null;
  /** 复用菜单组件管理键盘、焦点与关闭，不另建一套菜单交互。 */
  let menuRoot: Root | null = null;

  /** 可编辑输入保留原生复制语义，文件元数据只影响明确标记的节点。 */
  function fileAt(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof view.Element) || target.closest('input, textarea, [contenteditable="true"]')) return null;
    return target.closest<HTMLElement>('[data-file-path], [data-file-name]');
  }

  /** 文件名可由调用方指定；缺省从实际路径取最后一段，兼容两端分隔符。 */
  function fileName(file: HTMLElement): string {
    return file.dataset.fileName ?? file.dataset.filePath?.split(/[\\/]/u).filter(Boolean).at(-1) ?? '';
  }

  /** 有真实目录时复制绝对路径，其余资源保留服务端提供的路径，不猜测本机目录。 */
  function filePath(file: HTMLElement): string {
    const path = file.dataset.filePath!;
    const root = file.closest<HTMLElement>('[data-file-root]')?.dataset.fileRoot;
    return displayedFilePath(path, root);
  }

  /** 复制失败沿用应用错误出口，不能把无结果当作成功。 */
  async function write(text: string): Promise<void> {
    const zh = !document.documentElement.lang.startsWith('en');
    if (!(await copyText(text))) reportApplicationError(new Error(zh ? '复制失败，请重试。' : 'Could not copy. Please try again.'), { language: zh ? 'zh-CN' : 'en' });
  }

  /** 关闭不改变文件选中态。 */
  function close(): void {
    menuRoot?.unmount();
    menuRoot = null;
    menu?.remove();
    menu = null;
  }

  /** 原生“复制”菜单在没有文字选区时复制焦点文件名。 */
  function copy(event: ClipboardEvent): void {
    if (event.defaultPrevented || document.getSelection()?.toString()) return;
    const file = fileAt(event.target) ?? fileAt(document.activeElement);
    if (!file || !event.clipboardData) return;
    event.clipboardData.setData('text/plain', fileName(file));
    event.preventDefault();
  }

  /** Cmd/Ctrl+C 复制名称，增加 Shift 复制路径；文字选区优先。 */
  function keydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.altKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'c') return;
    const file = fileAt(event.target);
    if (!file || (event.shiftKey && !file.dataset.filePath)) return;
    event.preventDefault();
    void write(event.shiftKey ? filePath(file) : document.getSelection()?.toString() || fileName(file));
  }

  /** 已有业务右键菜单自行保留复制项，其余文件入口共用这两个动作。 */
  function contextmenu(event: MouseEvent): void {
    if (event.defaultPrevented) return;
    const file = fileAt(event.target);
    if (!file) return;
    event.preventDefault();
    close();
    const zh = !document.documentElement.lang.startsWith('en');
    /** 未知本机目录的历史资源明确标为相对路径，不伪造绝对路径。 */
    const path = file.dataset.filePath ? filePath(file) : undefined;
    const absolute = path && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(path);
    menu = document.createElement('div');
    menu.className = 'zeus-file-copy-layer';
    menu.setAttribute('popover', 'manual');
    menu.style.cssText = 'margin:0;padding:0;border:0;width:0;height:0;overflow:visible';
    (file.closest(':popover-open, [role="dialog"], .macos-ai-app') ?? document.body).append(menu);
    menu.showPopover();
    menuRoot = createRoot(menu);
    menuRoot.render(
      createElement(MenuSurface, {
        className: 'zeus-file-copy-menu',
        style: { left: event.clientX, top: event.clientY },
        onClose: () => close(),
        children: [[zh ? '复制文件名' : 'Copy file name', fileName(file)], ...(path ? [[absolute ? (zh ? '复制路径' : 'Copy path') : zh ? '复制相对路径' : 'Copy relative path', path]] : [])].map(([label, text]) =>
          createElement(
            'button',
            {
              key: label,
              type: 'button',
              role: 'menuitem',
              onClick: () => {
                close();
                void write(text!);
              },
            },
            label,
          ),
        ),
      }),
    );
  }

  /** 点击菜单外或离开窗口时立即关闭。 */
  function dismiss(event: Event): void {
    if (menu && !event.composedPath().includes(menu)) close();
  }
  document.addEventListener('copy', copy);
  document.addEventListener('keydown', keydown);
  document.addEventListener('contextmenu', contextmenu);
  view.addEventListener('blur', dismiss);
  return () => {
    close();
    document.removeEventListener('copy', copy);
    document.removeEventListener('keydown', keydown);
    document.removeEventListener('contextmenu', contextmenu);
    view.removeEventListener('blur', dismiss);
  };
}
