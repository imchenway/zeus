/** 异步粘贴仅恢复原输入框意外丢失的焦点，不改选区，也不覆盖用户的新焦点。 */
export function retainInputFocus(input: Pick<HTMLElement, 'contains' | 'focus' | 'isConnected'> | null): () => void {
  if (!input?.contains(document.activeElement)) return () => undefined;
  /** 处理期间点到别处或切换控件，表示用户已经离开原输入框。 */
  let movedAway = false;
  /** body 只是浏览器丢失焦点后的落点，不代表用户选择了另一个控件。 */
  const trackFocus = (event: FocusEvent) => {
    if (event.target instanceof Node && event.target !== document.body && !input.contains(event.target)) movedAway = true;
  };
  /** 点击不可聚焦区域也算主动离开，防止附件完成后抢回光标。 */
  const trackPointer = (event: PointerEvent) => {
    if (event.target instanceof Node && !input.contains(event.target)) movedAway = true;
  };
  document.addEventListener('focusin', trackFocus, true);
  document.addEventListener('pointerdown', trackPointer, true);
  return () => {
    // 等待附件和处理状态回写界面；不用动画帧，后台窗口也能完成清理。
    window.setTimeout(() => {
      document.removeEventListener('focusin', trackFocus, true);
      document.removeEventListener('pointerdown', trackPointer, true);
      if (!movedAway && input.isConnected && document.activeElement === document.body) input.focus({ preventScroll: true });
    }, 0);
  };
}
