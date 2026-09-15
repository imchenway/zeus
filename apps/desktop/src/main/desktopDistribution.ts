import { createDistributionContext } from '@zeus/shared';
import { desktopDistribution } from '@zeus/distribution';

/** 主进程和执行宿主共用的发行组装入口；服务层只接收此处的配置。 */
export const { zeusDistribution, zeusReleaseBaseUrl, zeusReleaseManifestUrl, zeusHomebrewCask, isZeusReleaseUrl } = createDistributionContext(desktopDistribution);
