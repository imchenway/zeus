import { createDistributionContext } from '@zeus/shared';
import { desktopDistribution } from '@zeus/distribution';

/** 渲染端只读取构建绑定的发行信息。 */
export const { zeusDistribution, zeusReleaseBaseUrl } = createDistributionContext(desktopDistribution);
