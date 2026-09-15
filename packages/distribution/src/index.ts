import type { DistributionConfig } from '@zeus/shared';
import config from './config.json' with { type: 'json' };

/** Zeus 发行信息只在此包维护，应用入口负责注入。 */
export const desktopDistribution = {
  ...config,
  channel: config.channel as DistributionConfig['channel'],
} satisfies DistributionConfig;
