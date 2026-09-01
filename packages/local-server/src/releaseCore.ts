/** Local Server 的发布清单与更新判定规则。 */
export const currentExecutionHostProtocolVersion = 2;

export interface ReleaseArtifactManifestInput {
  version: string;
  arch: string;
  appName?: string;
  caskSha256?: string;
  signed?: boolean;
  notarized?: boolean;
}

export interface ReleaseArtifactManifest {
  version: string;
  appName: string;
  arch: string;
  appBundlePath: string;
  dmgPath: string;
  caskPath: string;
  caskSha256: string | null;
  signed: boolean;
  notarized: boolean;
  statusLabel: string;
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
export type ReleaseUpdateArtifactKind = 'dmg';

export interface ReleaseUpdateArtifactInput {
  arch: ReleaseUpdateArtifactArch;
  kind: ReleaseUpdateArtifactKind;
  fileName: string;
  sha256: string;
  sizeBytes?: number;
  downloadUrl?: string;
}

export interface ReleaseUpdateArtifact {
  arch: ReleaseUpdateArtifactArch;
  kind: ReleaseUpdateArtifactKind;
  fileName: string;
  sha256: string;
  sizeBytes: number | null;
  downloadUrl: string;
}

export interface ReleaseUpdateManifestInput {
  version: string;
  channel: ReleaseUpdateChannel;
  repository: string;
  homebrewTap?: string;
  publishedAt?: string;
  signed?: boolean;
  notarized?: boolean;
  minimumSystemVersion?: string;
  executionHostProtocolVersion?: number;
  artifacts: ReleaseUpdateArtifactInput[];
}

export interface ReleaseUpdateManifest {
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
  };
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
  checkedAt: string;
}

export interface EvaluateReleaseUpdateAvailabilityInput {
  currentVersion: string;
  manifest: ReleaseUpdateManifest;
  platformArch: ReleaseUpdateArtifactArch;
  executionHostProtocolVersion?: number;
  checkedAt?: string;
}

/**
 * 构造 Zeus macOS 发布产物清单；只描述真实路径与已知签名状态，不伪造签名或 notarization 成功。
 */
export function buildReleaseArtifactManifest(input: ReleaseArtifactManifestInput): ReleaseArtifactManifest {
  const appName = input.appName?.trim() || 'Zeus';
  const version = input.version.trim();
  const arch = input.arch.trim();
  const signed = Boolean(input.signed);
  const notarized = Boolean(input.notarized);
  return {
    version,
    appName,
    arch,
    appBundlePath: `dist/mac-${arch}/${appName}.app`,
    dmgPath: `dist/${appName}-${version}-${arch}.dmg`,
    caskPath: 'dist/homebrew/zeus.rb',
    caskSha256: input.caskSha256?.trim() || null,
    signed,
    notarized,
    statusLabel: signed && notarized ? 'signed and notarized' : 'unsigned DMG',
  };
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
  const changelogPath = input.changelogPath.trim() || 'docs/release.md';
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

/** 构造公开 GitHub Release 更新清单；所有下载地址都来源于仓库名和版本，不内嵌本机路径。 */
export function buildReleaseUpdateManifest(input: ReleaseUpdateManifestInput): ReleaseUpdateManifest {
  const repository = normalizeRepository(input.repository);
  const homebrewTap = normalizeRepository(input.homebrewTap ?? 'imchenway/tap');
  const version = normalizeVersion(input.version);
  const tag = `v${version}`;
  const releaseBaseUrl = `https://github.com/${repository}/releases`;
  const releaseDownloadBaseUrl = `${releaseBaseUrl}/download/${tag}`;
  const artifacts = input.artifacts.map((artifact) => ({
    arch: artifact.arch,
    kind: artifact.kind,
    fileName: artifact.fileName.trim(),
    sha256: artifact.sha256.trim(),
    sizeBytes: typeof artifact.sizeBytes === 'number' && Number.isFinite(artifact.sizeBytes) ? artifact.sizeBytes : null,
    downloadUrl: artifact.downloadUrl?.trim() || `${releaseDownloadBaseUrl}/${encodeURIComponent(artifact.fileName.trim())}`,
  }));
  return {
    app: 'Zeus',
    schemaVersion: 1,
    version,
    channel: input.channel,
    repository,
    releasePageUrl: `${releaseBaseUrl}/tag/${tag}`,
    latestReleaseUrl: `${releaseBaseUrl}/latest`,
    releaseNotesUrl: `${releaseBaseUrl}/tag/${tag}`,
    publishedAt: input.publishedAt?.trim() || new Date(0).toISOString(),
    signed: Boolean(input.signed),
    notarized: Boolean(input.notarized),
    minimumSystemVersion: input.minimumSystemVersion?.trim() || '13.0',
    executionHostProtocolVersion:
      typeof input.executionHostProtocolVersion === 'number' && Number.isInteger(input.executionHostProtocolVersion) && input.executionHostProtocolVersion > 0 ? input.executionHostProtocolVersion : currentExecutionHostProtocolVersion,
    artifacts,
    homebrew: {
      tap: homebrewTap,
      cask: 'zeus',
      installCommand: `brew install --cask ${homebrewTap}/zeus`,
      upgradeCommand: `brew upgrade --cask ${homebrewTap}/zeus`,
    },
  };
}

/** 判断本机版本与 Release manifest 的关系；未签名/未公证时只给手动安装路径。 */
export function evaluateReleaseUpdateAvailability(input: EvaluateReleaseUpdateAvailabilityInput): ReleaseUpdateStatus {
  const currentVersion = normalizeVersion(input.currentVersion);
  const latestVersion = normalizeVersion(input.manifest.version);
  const checkedAt = input.checkedAt?.trim() || new Date().toISOString();
  const artifact = selectPreferredArtifact(input.manifest.artifacts, input.platformArch);
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
      reason: `发现新版本，但没有匹配 ${input.platformArch} 的 macOS 产物。`,
      checkedAt,
    };
  }
  const protocolCompatible = input.manifest.executionHostProtocolVersion === (input.executionHostProtocolVersion ?? currentExecutionHostProtocolVersion);
  const automaticInstallEnabled = input.manifest.signed && input.manifest.notarized && protocolCompatible;
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
      ? '发现新版本，产物已签名、公证且执行宿主协议兼容，可下载后安装。'
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
  if (value.channel !== 'stable' && value.channel !== 'preview') throw new Error('Release update manifest channel is invalid.');
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
    !isRecord(value.homebrew)
  ) {
    throw new Error('Release update manifest fields are invalid.');
  }
  const repository = normalizeRepository(value.repository);
  const artifacts = value.artifacts.map((candidate) => parseReleaseArtifact(candidate, repository, Boolean(options.allowLoopbackDownloadUrls)));
  const homebrewTap = typeof value.homebrew.tap === 'string' ? normalizeRepository(value.homebrew.tap) : '';
  if (
    !homebrewTap ||
    value.homebrew.cask !== 'zeus' ||
    typeof value.homebrew.installCommand !== 'string' ||
    typeof value.homebrew.upgradeCommand !== 'string' ||
    !isTrustedGithubUrl(value.releasePageUrl, repository) ||
    !isTrustedGithubUrl(value.latestReleaseUrl, repository) ||
    !isTrustedGithubUrl(value.releaseNotesUrl, repository)
  ) {
    throw new Error('Release update manifest links are invalid.');
  }
  return {
    app: 'Zeus',
    schemaVersion: 1,
    version: normalizeVersion(value.version),
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
    homebrew: {
      tap: homebrewTap,
      cask: 'zeus',
      installCommand: value.homebrew.installCommand,
      upgradeCommand: value.homebrew.upgradeCommand,
    },
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

function selectPreferredArtifact(artifacts: ReleaseUpdateArtifact[], arch: ReleaseUpdateArtifactArch): ReleaseUpdateArtifact | null {
  return artifacts.find((artifact) => artifact.arch === arch && artifact.kind === 'dmg') ?? artifacts.find((artifact) => artifact.arch === arch) ?? null;
}

function compareSemverLike(leftVersion: string, rightVersion: string): number {
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

function parseReleaseArtifact(value: unknown, repository: string, allowLoopbackDownloadUrls: boolean): ReleaseUpdateArtifact {
  if (
    !isRecord(value) ||
    (value.arch !== 'arm64' && value.arch !== 'x64') ||
    value.kind !== 'dmg' ||
    typeof value.fileName !== 'string' ||
    !value.fileName.trim().endsWith('.dmg') ||
    /[\\/]/u.test(value.fileName.trim()) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    (value.sizeBytes !== null && (typeof value.sizeBytes !== 'number' || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0)) ||
    typeof value.downloadUrl !== 'string' ||
    (!isTrustedGithubReleaseDownload(value.downloadUrl, repository) && !(allowLoopbackDownloadUrls && isLoopbackHttpUrl(value.downloadUrl)))
  ) {
    throw new Error('Release update artifact is invalid.');
  }
  return {
    arch: value.arch,
    kind: value.kind,
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

function isTrustedGithubReleaseDownload(value: string, repository: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith(`/${repository}/releases/download/`);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
