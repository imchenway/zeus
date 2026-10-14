import { ViewPlugin } from '@codemirror/view';

/** CodeMirror 默认预设生成的提示只在编辑器内部接入统一入口，不观察外部页面。 */
export const editorTooltips = ViewPlugin.define((view) => {
  /** 预设未提供统一提示配置；仅接管已存在的折叠和控制字符标题。 */
  const selector = '.cm-foldGutter [title], .cm-foldPlaceholder[title], .cm-specialChar[title]';

  /** 保留预设文案和无障碍名称，移除会与应用气泡重复显示的原生标题。 */
  function adopt(element: Element): void {
    /** 预设生成的标题原样交给共享管理器。 */
    const label = element.getAttribute('title');
    if (!label) return;
    element.setAttribute('data-icon-tooltip', label);
    if (!element.hasAttribute('aria-label')) element.setAttribute('aria-label', label);
    element.removeAttribute('title');
  }

  /** 只扫描本次新增的子树，避免每次输入遍历整个编辑器。 */
  function visit(node: Node): void {
    if (!(node instanceof Element)) return;
    if (node.matches(selector)) adopt(node);
    node.querySelectorAll(selector).forEach(adopt);
  }

  /** 虚拟化与折叠会重新生成标记，观察其创建和标题更新。 */
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') visit(record.target);
      else record.addedNodes.forEach(visit);
    }
  });
  visit(view.dom);
  observer.observe(view.dom, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] });
  return {
    /** 编辑器卸载时释放观察，不留下后台工作。 */
    destroy(): void {
      observer.disconnect();
    },
  };
});
