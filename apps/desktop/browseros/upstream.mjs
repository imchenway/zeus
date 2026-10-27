/** BrowserOS 固定上游；源码准备与 WebUI 资源构建共用同一身份。 */
export const browserOsUpstream = Object.freeze({
  /** 官方源码仓库；不从用户现有浏览器安装目录复制运行文件。 */
  repository: 'https://github.com/browseros-ai/BrowserOS.git',
  /** 本次经源码核对的集成修订，不自动跟随主分支更新。 */
  revision: 'cb47949e93c3c83978155a053534ec8f6c3190c1',
  /** 上游 CHROMIUM_VERSION 的真实值；README 中的旧值不作为构建输入。 */
  chromiumVersion: '155.0.8059.26',
  /** 上游 BASE_COMMIT 对应的 Chromium 源码身份。 */
  chromiumRevision: '16c3e55476d3564bea713314b2fff638749ce3e6',
  /** 上游根许可声明；生成的清单不授予额外许可。 */
  license: 'AGPL-3.0',
  /** 复用现有 React 界面的受控 WebUI 地址。 */
  webUiOrigin: 'chrome://zeus',
});
