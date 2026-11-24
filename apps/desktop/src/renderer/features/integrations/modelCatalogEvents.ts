/** 登录和模型配置变化使同一窗口内的展示缓存失效。 */
export const codexCapabilitiesChangedEvent = 'zeus:codex-capabilities-changed';
/** 同窗口和独立窗口共用外观失效信号。 */
export const modelProviderAppearanceChangedEvent = 'zeus:model-provider-appearance-changed';

/** 成功保存后只广播修订信号，图片仍从本地服务读取。 */
export function notifyModelProviderAppearanceChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(modelProviderAppearanceChangedEvent));
  try {
    window.localStorage.setItem(modelProviderAppearanceChangedEvent, crypto.randomUUID());
  } catch {
    // 当前窗口已收到通知，储存不可用时其他窗口在重新聚焦后读取。
  }
}
/** 目录读取绑定发起时的代次，旧响应不能覆盖之后的登录或配置。 */
let catalogGeneration = 0;
if (typeof window !== 'undefined')
  window.addEventListener(codexCapabilitiesChangedEvent, () => {
    catalogGeneration += 1;
  });

/** 只提供窗口内的失效代次，不保存账号、凭据或模型内容。 */
export function modelCatalogGeneration(): number {
  return catalogGeneration;
}
