/** 登录和模型配置变化使同一窗口内的展示缓存失效。 */
export const codexCapabilitiesChangedEvent = 'zeus:codex-capabilities-changed';
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
