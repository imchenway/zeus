/** 通用发行契约；具体发行配置由应用组装入口注入。 */
export interface DistributionConfig {
  readonly id: string;
  readonly repository: string;
  readonly upstreamRepository: string;
  readonly releaseBranch: string;
  readonly releaseTagPrefix: string;
  readonly integrationBranch: string;
  readonly channel: 'stable' | 'preview';
  readonly homebrewEnabled: boolean;
  readonly homebrewTap: string;
  readonly homebrewRepository: string;
  readonly cask: string;
  readonly requireManifestIdentity: boolean;
}

/** 未注入发行配置时沿用上游来源及既有清单格式。 */
export const upstreamDistribution: DistributionConfig = Object.freeze({
  id: 'imchenway.zeus',
  repository: 'imchenway/zeus',
  upstreamRepository: 'imchenway/zeus',
  releaseBranch: 'main',
  releaseTagPrefix: 'v',
  integrationBranch: 'main',
  channel: 'stable',
  homebrewEnabled: true,
  homebrewTap: 'imchenway/tap',
  homebrewRepository: 'imchenway/homebrew-tap',
  cask: 'zeus',
  requireManifestIdentity: false,
});

/** 每个宿主持有自己的不可变配置，不通过全局可变单例切换更新来源。 */
export function createDistributionContext(config: DistributionConfig = upstreamDistribution) {
  const zeusDistribution = Object.freeze({ ...config });
  const zeusReleaseBaseUrl = `https://github.com/${zeusDistribution.repository}/releases`;
  return {
    zeusDistribution,
    zeusReleaseBaseUrl,
    zeusReleaseManifestUrl: `${zeusReleaseBaseUrl}/latest/download/zeus-release-manifest.json`,
    zeusHomebrewCask: `${zeusDistribution.homebrewTap}/${zeusDistribution.cask}`,
    isZeusReleaseUrl(value: string, downloadOnly = false): boolean {
      try {
        const url = new URL(value);
        const prefix = `/${zeusDistribution.repository}/releases/`;
        return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password && url.pathname.startsWith(downloadOnly ? `${prefix}download/` : prefix);
      } catch {
        return false;
      }
    },
  };
}
