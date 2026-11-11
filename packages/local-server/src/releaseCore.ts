import { describeUserFacingError, userFacingErrorCause, type UserFacingErrorCause } from '@zeus/shared';

/** Local Server 的发布清单与更新判定规则。 */
export const currentExecutionHostProtocolVersion = 2;

/** 官方 CDN 中的 Zeus 发布目录，安装包和更新清单共用这一来源。 */
export const releaseDownloadBaseUrl = 'https://zeus-download.hyphatech.cn/zeus';

/** 两个平台共用 CDN 优先、GitHub 备用的固定清单地址。 */
export function releaseUpdateManifestUrls(platform: ReleaseUpdatePlatform): string[] {
  const fileName = platform === 'win32' ? 'zeus-release-manifest-win32.json' : 'zeus-release-manifest.json';
  return [`${releaseDownloadBaseUrl}/updates/${fileName}`, `https://github.com/imchenway/zeus/releases/latest/download/${fileName}`];
}

/** 备用下载必须保持版本和文件身份一致，不从远端清单接收任意镜像地址。 */
export function releaseArtifactDownloadUrls(version: string, fileName: string): string[] {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(version) || version.length > 128 || !/^[\w.+-]+\.(?:dmg|exe)$/u.test(fileName) || fileName.length > 256) throw new Error('更新安装包版本或文件名无效。');
  return [`${releaseDownloadBaseUrl}/releases/${encodeURIComponent(version)}/${encodeURIComponent(fileName)}`, `https://github.com/imchenway/zeus/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(fileName)}`];
}

/** 每一次网络重定向都限定在官方 CDN、仓库或 GitHub 资产服务内。 */
export function isTrustedReleaseResponseUrl(url: URL): boolean {
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  if (url.hostname === 'zeus-download.hyphatech.cn') return url.pathname.startsWith('/zeus/updates/') || url.pathname.startsWith('/zeus/releases/');
  if (url.hostname === 'github.com') return url.pathname.startsWith('/imchenway/zeus/releases/');
  return ['objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(url.hostname);
}

export interface ReleaseReadinessInput {
  hasAppleCertificate: boolean;
  hasNotaryCredentials: boolean;
}

export interface ReleaseReadiness {
  canBuildUnsignedArtifacts: true;
  canSign: boolean;
  canNotarize: boolean;
  waitingFor: string[];
}

export interface AutoUpdatePolicyInput {
  currentVersion: string;
  channel: 'manual' | 'stable' | 'preview';
  hasReleaseWorkflow: boolean;
  hasSignedAndNotarizedArtifacts: boolean;
  changelogPath: string;
}

export interface AutoUpdatePolicy {
  currentVersion: string;
  channel: 'manual' | 'stable' | 'preview';
  checkMode: 'manual' | 'startup_and_manual';
  updateFeedConfigured: boolean;
  changelogPath: string;
  waitingFor: string[];
  label: string;
}

export type ReleaseUpdateChannel = 'stable' | 'preview';
export type ReleaseUpdateArtifactArch = 'arm64' | 'x64';
/** 安装包格式与平台严格对应。 */
export type ReleaseUpdateArtifactKind = 'dmg' | 'exe';
/** 官方桌面发行平台，不将 CPU 架构作为操作系统身份。 */
export type ReleaseUpdatePlatform = 'darwin' | 'win32';

export interface ReleaseUpdateArtifact {
  /** 已有 macOS 清单缺省平台仍明确归属 Darwin。 */
  platform?: ReleaseUpdatePlatform;
  arch: ReleaseUpdateArtifactArch;
  kind: ReleaseUpdateArtifactKind;
  fileName: string;
  sha256: string;
  sizeBytes: number | null;
  downloadUrl: string;
}

export interface ReleaseUpdateManifest {
  /** 每个稳定清单只包含同一平台的安装包。 */
  platform?: ReleaseUpdatePlatform;
  app: 'Zeus';
  schemaVersion: 1;
  version: string;
  channel: ReleaseUpdateChannel;
  repository: string;
  releasePageUrl: string;
  latestReleaseUrl: string;
  releaseNotesUrl: string;
  publishedAt: string;
  signed: boolean;
  notarized: boolean;
  minimumSystemVersion: string;
  executionHostProtocolVersion: number;
  artifacts: ReleaseUpdateArtifact[];
  homebrew: {
    tap: string;
    cask: 'zeus';
    installCommand: string;
    upgradeCommand: string;
  } | null;
}

export type ReleaseUpdateStatusKind = 'up_to_date' | 'available' | 'unavailable';
export type ReleaseUpdateRecommendedAction = 'none' | 'open_download_page' | 'download_and_install';

export interface ReleaseUpdateStatus {
  status: ReleaseUpdateStatusKind;
  currentVersion: string;
  latestVersion: string;
  channel: ReleaseUpdateChannel;
  releasePageUrl: string;
  artifact: ReleaseUpdateArtifact | null;
  executionHostProtocolVersion: number;
  automaticInstallEnabled: boolean;
  recommendedAction: ReleaseUpdateRecommendedAction;
  label: string;
  reason: string;
  /** 清单读取失败的脱敏原因，跨进程后仍可解释底层连接错误。 */
  error?: UserFacingErrorCause;
  checkedAt: string;
}

export interface EvaluateReleaseUpdateAvailabilityInput {
  currentVersion: string;
  manifest: ReleaseUpdateManifest;
  platformArch: ReleaseUpdateArtifactArch;
  /** 未显式指定时读取当前宿主平台。 */
  platform?: ReleaseUpdatePlatform;
  executionHostProtocolVersion?: number;
  checkedAt?: string;
}

/**
 * 根据真实外部配置输入给出发布就绪度；缺少证书时仍允许构建 unsigned 本地产物。
 */
export function detectReleaseReadiness(input: ReleaseReadinessInput): ReleaseReadiness {
  const waitingFor: string[] = [];
  if (!input.hasAppleCertificate) waitingFor.push('Apple signing certificate');
  if (!input.hasNotaryCredentials) waitingFor.push('Apple notarization credentials');
  return {
    canBuildUnsignedArtifacts: true,
    canSign: input.hasAppleCertificate,
    canNotarize: input.hasAppleCertificate && input.hasNotaryCredentials,
    waitingFor,
  };
}

/**
 * 描述自动更新预留状态。当前 Zeus 只支持手动更新，不伪造 feed、签名或公证产物。
 */
export function buildAutoUpdatePolicy(input: AutoUpdatePolicyInput): AutoUpdatePolicy {
  const currentVersion = input.currentVersion.trim() || '0.0.0';
  const channel = input.channel === 'stable' || input.channel === 'preview' ? input.channel : 'manual';
  const changelogPath = input.changelogPath.trim();
  const waitingFor: string[] = [];
  if (!input.hasReleaseWorkflow) waitingFor.push('GitHub Release workflow');
  if (!input.hasSignedAndNotarizedArtifacts) waitingFor.push('signed and notarized artifacts');
  const updateFeedConfigured = input.hasReleaseWorkflow && input.hasSignedAndNotarizedArtifacts;
  return {
    currentVersion,
    channel,
    checkMode: updateFeedConfigured ? 'startup_and_manual' : 'manual',
    updateFeedConfigured,
    changelogPath,
    waitingFor,
    label: updateFeedConfigured ? `${channel === 'preview' ? 'Preview' : 'Stable'} 更新 · ${currentVersion}` : `手动更新 · ${currentVersion}`,
  };
}

/** 判断本机版本与 Release manifest 的关系；未签名/未公证时只给手动安装路径。 */
export function evaluateReleaseUpdateAvailability(input: EvaluateReleaseUpdateAvailabilityInput): ReleaseUpdateStatus {
  const currentVersion = normalizeVersion(input.currentVersion);
  const latestVersion = normalizeVersion(input.manifest.version);
  const checkedAt = input.checkedAt?.trim() || new Date().toISOString();
  const platform = input.platform ?? (process.platform === 'win32' ? 'win32' : 'darwin');
  /** 旧 macOS 清单的平台缺省值是长期协议，不接受跨平台安装包。 */
  const artifact = (input.manifest.platform ?? 'darwin') === platform ? selectPreferredArtifact(input.manifest.artifacts, input.platformArch, platform) : null;
  if (compareSemverLike(currentVersion, latestVersion) >= 0) {
    return {
      status: 'up_to_date',
      currentVersion,
      latestVersion,
      channel: input.manifest.channel,
      releasePageUrl: input.manifest.releasePageUrl,
      artifact,
      executionHostProtocolVersion: input.manifest.executionHostProtocolVersion,
      automaticInstallEnabled: false,
      recommendedAction: 'none',
      label: `已是最新版本 · ${currentVersion}`,
      reason: '当前版本已不低于 Release manifest 中的最新版本。',
      checkedAt,
    };
  }
  if (!artifact) {
    return {
      status: 'unavailable',
      currentVersion,
      latestVersion,
      channel: input.manifest.channel,
      releasePageUrl: input.manifest.releasePageUrl,
      artifact: null,
      executionHostProtocolVersion: input.manifest.executionHostProtocolVersion,
      automaticInstallEnabled: false,
      recommendedAction: 'open_download_page',
      label: `发现新版本 · ${latestVersion}`,
      reason: `发现新版本，但没有匹配 ${input.platformArch} 的 ${platform} 产物。`,
      checkedAt,
    };
  }
  const protocolCompatible = input.manifest.executionHostProtocolVersion === (input.executionHostProtocolVersion ?? currentExecutionHostProtocolVersion);
  const automaticInstallEnabled = input.manifest.signed && (platform === 'win32' || input.manifest.notarized) && (platform === 'win32' || protocolCompatible);
  return {
    status: 'available',
    currentVersion,
    latestVersion,
    channel: input.manifest.channel,
    releasePageUrl: input.manifest.releasePageUrl,
    artifact,
    executionHostProtocolVersion: input.manifest.executionHostProtocolVersion,
    automaticInstallEnabled,
    recommendedAction: automaticInstallEnabled ? 'download_and_install' : 'open_download_page',
    label: `发现新版本 · ${latestVersion}`,
    reason: automaticInstallEnabled
      ? platform === 'win32'
        ? '发现已签名 Windows 更新，确认停止活动工作并完整退出后安装。'
        : '发现新版本，产物已签名、公证且执行宿主协议兼容，可下载后安装。'
      : platform === 'win32'
        ? '发现新版本，但更新清单未声明正式签名，只允许打开 GitHub Release 手动安装。'
        : !protocolCompatible
          ? '发现新版本，执行宿主协议已变化；通过 Zeus 编排的 Homebrew 升级会先安全关闭旧宿主。'
          : '发现新版本，但当前产物未同时签名和公证，只允许打开 GitHub Release 手动安装。',
    checkedAt,
  };
}

/** 校验远程更新清单；签名、公证布尔值只能开启后续复验，不能替代本机产物校验。 */
export function parseReleaseUpdateManifest(value: unknown, options: { allowLoopbackDownloadUrls?: boolean } = {}): ReleaseUpdateManifest {
  if (!isRecord(value)) throw new Error('Release update manifest must be an object.');
  if (value.app !== 'Zeus' || value.schemaVersion !== 1) throw new Error('Release update manifest identity or schema is incompatible.');
  if (value.repository !== 'imchenway/zeus') throw new Error('更新清单不是 Zeus 官方发布来源。');
  if (value.channel !== 'stable') throw new Error('更新清单不是 Zeus 稳定发布渠道。');
  /** Windows 使用独立清单；原有 macOS 清单名称与格式保持稳定。 */
  const platform = value.platform ?? 'darwin';
  if (platform !== 'darwin' && platform !== 'win32') throw new Error('更新清单平台不受支持。');
  if (
    typeof value.version !== 'string' ||
    typeof value.repository !== 'string' ||
    typeof value.releasePageUrl !== 'string' ||
    typeof value.latestReleaseUrl !== 'string' ||
    typeof value.releaseNotesUrl !== 'string' ||
    typeof value.publishedAt !== 'string' ||
    typeof value.signed !== 'boolean' ||
    typeof value.notarized !== 'boolean' ||
    typeof value.minimumSystemVersion !== 'string' ||
    !Number.isInteger(value.executionHostProtocolVersion) ||
    Number(value.executionHostProtocolVersion) <= 0 ||
    !Array.isArray(value.artifacts) ||
    (platform === 'darwin' && !isRecord(value.homebrew))
  ) {
    throw new Error('Release update manifest fields are invalid.');
  }
  const repository = normalizeRepository(value.repository);
  /** 安装包地址必须绑定清单版本，不能将另一个版本作为备用文件。 */
  const version = normalizeVersion(value.version);
  const artifacts = value.artifacts.map((candidate) => parseReleaseArtifact(candidate, version, Boolean(options.allowLoopbackDownloadUrls), platform));
  /** Homebrew 只属于 macOS，不能成为 Windows 清单的必填凭据。 */
  const homebrew = isRecord(value.homebrew) ? value.homebrew : null;
  const homebrewTap = typeof homebrew?.tap === 'string' ? normalizeRepository(homebrew.tap) : '';
  if (
    (platform === 'darwin' && (homebrewTap !== 'imchenway/tap' || homebrew?.cask !== 'zeus' || typeof homebrew.installCommand !== 'string' || typeof homebrew.upgradeCommand !== 'string')) ||
    !isTrustedGithubUrl(value.releasePageUrl, repository) ||
    !isTrustedGithubUrl(value.latestReleaseUrl, repository) ||
    !isTrustedGithubUrl(value.releaseNotesUrl, repository)
  ) {
    throw new Error('Release update manifest links are invalid.');
  }
  return {
    app: 'Zeus',
    platform,
    schemaVersion: 1,
    version,
    channel: value.channel,
    repository,
    releasePageUrl: value.releasePageUrl,
    latestReleaseUrl: value.latestReleaseUrl,
    releaseNotesUrl: value.releaseNotesUrl,
    publishedAt: value.publishedAt,
    signed: value.signed,
    notarized: value.notarized,
    minimumSystemVersion: value.minimumSystemVersion,
    executionHostProtocolVersion: Number(value.executionHostProtocolVersion),
    artifacts,
    homebrew:
      platform === 'darwin' && homebrew
        ? {
            tap: homebrewTap,
            cask: 'zeus',
            installCommand: String(homebrew.installCommand),
            upgradeCommand: String(homebrew.upgradeCommand),
          }
        : null,
  };
}

function normalizeRepository(repository: string): string {
  const trimmed = repository
    .trim()
    .replace(/^https:\/\/github\.com\//u, '')
    .replace(/\.git$/u, '');
  return trimmed || 'imchenway/zeus';
}

function normalizeVersion(version: string): string {
  const trimmed = version.trim().replace(/^v/u, '');
  return trimmed || '0.0.0';
}

/** 平台和架构必须同时匹配，禁止以其他平台的同架构产物兜底。 */
function selectPreferredArtifact(artifacts: ReleaseUpdateArtifact[], arch: ReleaseUpdateArtifactArch, platform: ReleaseUpdatePlatform): ReleaseUpdateArtifact | null {
  return artifacts.find((artifact) => artifact.arch === arch && (artifact.platform ?? 'darwin') === platform && artifact.kind === (platform === 'win32' ? 'exe' : 'dmg')) ?? null;
}

/** 比较已规范化的数字版本；Codex 与 Zeus 更新检测共用同一顺序规则。 */
export function compareSemverLike(leftVersion: string, rightVersion: string): number {
  const left = parseSemverParts(leftVersion);
  const right = parseSemverParts(rightVersion);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function parseSemverParts(version: string): number[] {
  return normalizeVersion(version)
    .split(/[.-]/u)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function parseReleaseArtifact(value: unknown, version: string, allowLoopbackDownloadUrls: boolean, platform: ReleaseUpdatePlatform): ReleaseUpdateArtifact {
  if (
    !isRecord(value) ||
    (value.arch !== 'arm64' && value.arch !== 'x64') ||
    (value.platform !== undefined && value.platform !== platform) ||
    value.kind !== (platform === 'win32' ? 'exe' : 'dmg') ||
    typeof value.fileName !== 'string' ||
    !value.fileName.trim().endsWith(platform === 'win32' ? '.exe' : '.dmg') ||
    /[\\/]/u.test(value.fileName.trim()) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    (value.sizeBytes !== null && (typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0)) ||
    typeof value.downloadUrl !== 'string' ||
    (!(allowLoopbackDownloadUrls && isLoopbackHttpUrl(value.downloadUrl)) && !releaseArtifactDownloadUrls(version, value.fileName.trim()).includes(value.downloadUrl))
  ) {
    throw new Error('Release update artifact is invalid.');
  }
  return {
    platform,
    arch: value.arch,
    kind: value.kind as ReleaseUpdateArtifactKind,
    fileName: value.fileName.trim(),
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
    downloadUrl: value.downloadUrl,
  };
}

function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port) && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function isTrustedGithubUrl(value: string, repository: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith(`/${repository}/releases`);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 更新清单只信任 Zeus 官方下载目录；隔离验收可显式使用本机服务。 */
export function resolveReleaseUpdateManifestUrl(configured: string | undefined, allowUntrustedTest: boolean, platform: ReleaseUpdatePlatform = process.platform === 'win32' ? 'win32' : 'darwin'): string {
  const candidate = configured?.trim() || releaseUpdateManifestUrls(platform)[0]!;
  const url = new URL(candidate);
  if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password && url.pathname.startsWith('/imchenway/zeus/releases/')) return url.toString();
  if (url.toString() === releaseUpdateManifestUrls(platform)[0]) return url.toString();
  if (allowUntrustedTest && url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port)) return url.toString();
  throw new Error('Zeus release update manifest URL is not trusted.');
}

/** 桌面与独立 Core 共用清单校验；网络请求由各自运行环境提供。 */
export interface ReadReleaseUpdateStatusOptions extends Omit<EvaluateReleaseUpdateAvailabilityInput, 'manifest'> {
  /** 缺省读取当前平台的官方稳定清单。 */
  manifestUrl?: string;
  /** Electron 使用系统网络，独立 Core 使用 Node 网络。 */
  request?: (url: string, init: RequestInit) => Promise<Response>;
  /** 仅显式隔离验收允许本机清单与下载地址。 */
  allowUntrustedTest?: boolean;
}

/** 所有更新入口保留相同的来源、内容校验和脱敏错误原因。 */
export async function readReleaseUpdateStatus(input: ReadReleaseUpdateStatusOptions): Promise<ReleaseUpdateStatus> {
  /** 记录本次检查时间，不把旧清单缓存当成本次成功。 */
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  try {
    /** 清单地址先通过官方来源限制，再交给平台网络请求。 */
    const platform = input.platform ?? (process.platform === 'win32' ? 'win32' : 'darwin');
    const manifestUrl = resolveReleaseUpdateManifestUrl(input.manifestUrl, Boolean(input.allowUntrustedTest), platform);
    const sources = releaseUpdateManifestUrls(platform);
    const request = input.request ?? fetch;
    let manifest: ReleaseUpdateManifest;
    try {
      manifest = await loadReleaseUpdateManifest(manifestUrl, request, Boolean(input.allowUntrustedTest), manifestUrl === sources[0] ? 1 : 2);
    } catch (error) {
      /** 来源或内容校验失败不能通过切换镜像绕过；仅传输和 HTTP 可用性故障回退。 */
      if (manifestUrl !== sources[0] || !isManifestTransportFailure(error)) throw error;
      manifest = await loadReleaseUpdateManifest(sources[1]!, request, Boolean(input.allowUntrustedTest), 2);
    }
    return evaluateReleaseUpdateAvailability({ ...input, manifest, checkedAt });
  } catch (error) {
    return {
      status: 'unavailable',
      currentVersion: input.currentVersion,
      latestVersion: input.currentVersion,
      channel: 'stable',
      releasePageUrl: 'https://github.com/imchenway/zeus/releases/latest',
      artifact: null,
      executionHostProtocolVersion: input.executionHostProtocolVersion ?? currentExecutionHostProtocolVersion,
      automaticInstallEnabled: false,
      recommendedAction: 'open_download_page',
      label: '暂未取得更新清单',
      reason: describeUserFacingError(error).message,
      error: userFacingErrorCause(error),
      checkedAt,
    };
  }
}

/** 清单正文和重定向共用期限；CDN 五秒一次、备用源十秒两次，总预算小于三十秒。 */
async function loadReleaseUpdateManifest(releaseUpdateManifestUrl: string, request: NonNullable<ReadReleaseUpdateStatusOptions['request']>, allowUntrustedTest: boolean, attempts: number): Promise<ReleaseUpdateManifest> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      /** 超时同时约束连接、重定向与正文读取。 */
      const signal = AbortSignal.timeout(releaseUpdateManifestUrl.startsWith(`${releaseDownloadBaseUrl}/`) ? 5_000 : 10_000);
      /** 网络错误与清单校验错误分开标记，不能把格式错误当作断网重试。 */
      const response = await requestReleaseManifest(releaseUpdateManifestUrl, request, signal, allowUntrustedTest);
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error(`更新服务返回 HTTP ${response.status}。`), {
          code: response.status === 408 || response.status === 429 || response.status >= 500 ? 'ZEUS_RELEASE_MANIFEST_HTTP_TRANSIENT' : 'ZEUS_RELEASE_MANIFEST_HTTP_REJECTED',
        });
      }
      /** 正文传输中断可重试；已收到的无效 JSON 或清单不重试。 */
      const body = await response.text().catch((cause: unknown) => {
        throw Object.assign(new Error('未能完整读取更新清单。', { cause }), { code: signal.aborted ? 'ZEUS_RELEASE_MANIFEST_TIMEOUT' : 'ZEUS_RELEASE_MANIFEST_NETWORK' });
      });
      try {
        return parseReleaseUpdateManifest(JSON.parse(body), { allowLoopbackDownloadUrls: allowUntrustedTest });
      } catch (cause) {
        throw Object.assign(new Error('更新清单校验失败。', { cause }), { code: 'ZEUS_RELEASE_MANIFEST_INVALID' });
      }
    } catch (error) {
      /** 只重试传输中断、限流或服务暂时故障，不重试明确的拒绝与内容错误。 */
      const failure = userFacingErrorCause(error);
      if (attempt + 1 >= attempts || !['ZEUS_RELEASE_MANIFEST_NETWORK', 'ZEUS_RELEASE_MANIFEST_TIMEOUT', 'ZEUS_RELEASE_MANIFEST_HTTP_TRANSIENT'].includes(failure.code ?? '')) throw error;
      await new Promise<void>((resolveRetry) => setTimeout(resolveRetry, 400));
    }
  }
}

/** 清单损坏和跨域跳转属于校验错误，不属于可以使用备用源的网络故障。 */
function isManifestTransportFailure(error: unknown): boolean {
  return ['ZEUS_RELEASE_MANIFEST_NETWORK', 'ZEUS_RELEASE_MANIFEST_TIMEOUT', 'ZEUS_RELEASE_MANIFEST_HTTP_TRANSIENT', 'ZEUS_RELEASE_MANIFEST_HTTP_REJECTED'].includes(userFacingErrorCause(error).code ?? '');
}

/** 手动处理最多五次重定向，避免运行环境隐藏最终 URL 后失去来源约束。 */
async function requestReleaseManifest(source: string, request: NonNullable<ReadReleaseUpdateStatusOptions['request']>, signal: AbortSignal, allowUntrustedTest: boolean): Promise<Response> {
  let url = new URL(source);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await request(url.href, { headers: { accept: 'application/json' }, redirect: 'manual', signal }).catch((cause: unknown) => {
      throw Object.assign(new Error('无法连接更新服务。', { cause }), { code: signal.aborted ? 'ZEUS_RELEASE_MANIFEST_TIMEOUT' : 'ZEUS_RELEASE_MANIFEST_NETWORK' });
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    const target = location ? new URL(location, url) : null;
    if (redirects === 5 || !target || (!isTrustedReleaseResponseUrl(target) && !(allowUntrustedTest && isLoopbackHttpUrl(target.href)))) {
      throw Object.assign(new Error('更新清单重定向离开了官方来源或超过允许次数。'), { code: 'ZEUS_RELEASE_MANIFEST_INVALID' });
    }
    url = target;
  }
  throw new Error('更新清单重定向未完成。');
}
