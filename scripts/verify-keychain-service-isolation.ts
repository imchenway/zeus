import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveDesktopKeychainService } from '../apps/desktop/src/main/secretServiceIdentity.js';

const repositoryRoot = resolve(import.meta.dirname, '..');
const canonicalTestRoot = resolve('/tmp/zeus-keychain-service-probe/root');
const equivalentTestRoot = join(canonicalTestRoot, 'nested', '..');
const otherTestRoot = resolve('/tmp/zeus-keychain-service-probe/other-root');
const expectedTestService = `Zeus Test ${createHash('sha256').update(canonicalTestRoot).digest('hex').slice(0, 16)}`;

const productionService = resolveDesktopKeychainService({ testDistribution: false, dataRootPath: canonicalTestRoot });
const productionServiceFromOtherRoot = resolveDesktopKeychainService({ testDistribution: false, dataRootPath: otherTestRoot });
const testService = resolveDesktopKeychainService({ testDistribution: true, dataRootPath: canonicalTestRoot });
const equivalentTestService = resolveDesktopKeychainService({ testDistribution: true, dataRootPath: equivalentTestRoot });
const otherTestService = resolveDesktopKeychainService({ testDistribution: true, dataRootPath: otherTestRoot });

assertProbe(productionService === 'Zeus' && productionServiceFromOtherRoot === 'Zeus', '正式身份必须始终使用历史 Zeus service，不能随数据根漂移');
assertProbe(testService === expectedTestService, 'Test service 必须只按规范化数据根的 SHA-256 身份派生');
assertProbe(equivalentTestService === testService, '同一规范路径的等价写法必须收敛到同一个 Test service');
assertProbe(otherTestService !== testService, '不同 Test 数据根必须使用不同 service');
assertProbe(/^Zeus Test [a-f0-9]{16}$/u.test(testService), 'Test service 格式必须稳定、无控制字符且满足 security-core 长度预算');

const sourceFiles = {
  main: 'apps/desktop/src/main/main.ts',
  runtime: 'apps/desktop/src/main/localServerRuntime.ts',
  protocol: 'apps/desktop/src/main/executionHostProtocol.ts',
  host: 'apps/desktop/src/main/executionHost.ts',
  core: 'packages/local-server/src/index.ts',
} as const;
const sources = Object.fromEntries(await Promise.all(Object.entries(sourceFiles).map(async ([key, file]) => [key, await readFile(join(repositoryRoot, file), 'utf8')] as const))) as Record<keyof typeof sourceFiles, string>;

const wiring = {
  mainDerivesFromPreparedDataRoot:
    sources.main.includes("import { resolveDesktopKeychainService } from './secretServiceIdentity.js';") &&
    sources.main.includes('dataRootPath: activeZeusDataLayout().root') &&
    sources.main.includes('const keychainService = activeDesktopKeychainService();'),
  mainDirectStoreUsesDerivedService: sources.main.includes('createMacOSKeychainStore({ service: activeDesktopKeychainService() })'),
  desktopOptionsRequireService: sources.runtime.includes('keychainService: string;'),
  ownedAndDetachedPathsForwardService:
    countMatches(sources.runtime, /keychainService: options\.keychainService/gu) >= 2 &&
    sources.runtime.includes('verifyZeusDataRootHostIdentity({ rootPath: options.userDataPath, expected: options.dataRootIdentity, keychainService: options.keychainService })'),
  bootstrapRequiresAndValidatesService: sources.protocol.includes('keychainService: string;') && sources.protocol.includes('isNonEmptyString(value.keychainService)'),
  executionHostForwardsService: sources.host.includes('keychainService: bootstrap.keychainService'),
  coreOptionsRequireService: sources.core.includes('keychainService: string;'),
  coreStoreUsesForwardedService: sources.core.includes('createMacOSKeychainStore({ service: options.keychainService })'),
  noProductDefaultStoreConstruction: countMatches(`${sources.main}\n${sources.core}`, /createMacOSKeychainStore\(\s*\)/gu) === 0,
  exactlyTwoProductStoreConstructions: countMatches(`${sources.main}\n${sources.core}`, /createMacOSKeychainStore\(/gu) === 2,
};

for (const [name, passed] of Object.entries(wiring)) assertProbe(passed, `Keychain service 接线证据缺失：${name}`);

console.log(
  JSON.stringify(
    {
      status: 'passed',
      keychainAccessAttempted: false,
      productionService,
      testService,
      otherTestService,
      canonicalizationStable: equivalentTestService === testService,
      wiring,
    },
    null,
    2,
  ),
);

function countMatches(content: string, pattern: RegExp): number {
  return [...content.matchAll(pattern)].length;
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Keychain service 隔离验证失败：${message}`);
}
