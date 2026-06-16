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
  zipPath: string;
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
export type ReleaseUpdateArtifactKind = 'dmg' | 'zip';

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
  publishedAt?: string;
  signed?: boolean;
  notarized?: boolean;
  minimumSystemVersion?: string;
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
  installScriptUrl: string;
  publishedAt: string;
  signed: boolean;
  notarized: boolean;
  minimumSystemVersion: string;
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
  checkedAt?: string;
}

export interface InstallScriptPlan {
  repository: string;
  channel: ReleaseUpdateChannel;
  installUrl: string;
  supportedEnvironmentVariables: ['ZEUS_NON_INTERACTIVE', 'ZEUS_INSTALL_DIR', 'ZEUS_CHANNEL'];
  defaultInstallDir: '/Applications';
  command: string;
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
    zipPath: `dist/${appName}-${version}-${arch}.zip`,
    caskPath: 'dist/homebrew/zeus.rb',
    caskSha256: input.caskSha256?.trim() || null,
    signed,
    notarized,
    statusLabel: signed && notarized ? 'signed and notarized' : 'unsigned DMG/ZIP',
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
    installScriptUrl: `${releaseBaseUrl}/latest/download/install.sh`,
    publishedAt: input.publishedAt?.trim() || new Date(0).toISOString(),
    signed: Boolean(input.signed),
    notarized: Boolean(input.notarized),
    minimumSystemVersion: input.minimumSystemVersion?.trim() || '13.0',
    artifacts,
    homebrew: {
      tap: repository,
      cask: 'zeus',
      installCommand: `brew install --cask ${repository}/zeus`,
      upgradeCommand: 'brew upgrade --cask zeus',
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
      automaticInstallEnabled: false,
      recommendedAction: 'open_download_page',
      label: `发现新版本 · ${latestVersion}`,
      reason: `发现新版本，但没有匹配 ${input.platformArch} 的 macOS 产物。`,
      checkedAt,
    };
  }
  const automaticInstallEnabled = input.manifest.signed && input.manifest.notarized;
  return {
    status: 'available',
    currentVersion,
    latestVersion,
    channel: input.manifest.channel,
    releasePageUrl: input.manifest.releasePageUrl,
    artifact,
    automaticInstallEnabled,
    recommendedAction: automaticInstallEnabled ? 'download_and_install' : 'open_download_page',
    label: `发现新版本 · ${latestVersion}`,
    reason: automaticInstallEnabled ? '发现新版本，产物已签名并公证，可下载后安装。' : '发现新版本，但当前产物未同时签名和公证，只允许打开 GitHub Release 手动安装。',
    checkedAt,
  };
}

/** 安装脚本计划用于 README、Release workflow 和应用内“新用户安装”入口保持同一 URL。 */
export function buildInstallScriptPlan(input: { repository: string; channel: ReleaseUpdateChannel }): InstallScriptPlan {
  const repository = normalizeRepository(input.repository);
  const installUrl = `https://github.com/${repository}/releases/latest/download/install.sh`;
  return {
    repository,
    channel: input.channel,
    installUrl,
    supportedEnvironmentVariables: ['ZEUS_NON_INTERACTIVE', 'ZEUS_INSTALL_DIR', 'ZEUS_CHANNEL'],
    defaultInstallDir: '/Applications',
    command: `curl -fsSL ${installUrl} | bash`,
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
