import { createHash } from 'node:crypto';
import type { ZeusDataRootProfile } from './dataRootIdentity.js';
import { canonicalizeZeusDataRootPath } from './zeusDataRootPath.js';

const productionKeychainService = 'Zeus';

/**
 * 正式应用继续读取既有 `Zeus` Keychain 项。Test 与 development 按规范数据根隔离，
 * 避免任务 worktree、开发环境与正式应用共享或覆盖凭据。
 */
export function resolveDesktopKeychainService(input: { profile: ZeusDataRootProfile; dataRootPath: string } | { testDistribution: boolean; dataRootPath: string }): string {
  const profile = 'profile' in input ? input.profile : input.testDistribution ? 'test' : 'production';
  if (profile === 'production') return productionKeychainService;
  /** 钥匙串隔离必须绑定真实数据根，避免 `/tmp` 与 `/private/tmp` 为同一目录生成两套凭据。 */
  const identity = createHash('sha256').update(canonicalizeZeusDataRootPath(input.dataRootPath)).digest('hex').slice(0, 16);
  return profile === 'test' ? `Zeus Test ${identity}` : `Zeus Development ${identity}`;
}
