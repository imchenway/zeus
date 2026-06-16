import { describe, expect, it } from 'vitest';
import { buildAutoUpdatePolicy, buildInstallScriptPlan, buildReleaseArtifactManifest, buildReleaseUpdateManifest, detectReleaseReadiness, evaluateReleaseUpdateAvailability } from '../src/index.js';

describe('release-core', () => {
  it('builds a deterministic macOS release artifact manifest without claiming signing exists', () => {
    const manifest = buildReleaseArtifactManifest({
      version: '0.1.0',
      arch: 'arm64',
      appName: 'Zeus',
      caskSha256: 'real-sha',
    });

    expect(manifest).toEqual({
      version: '0.1.0',
      appName: 'Zeus',
      arch: 'arm64',
      appBundlePath: 'dist/mac-arm64/Zeus.app',
      dmgPath: 'dist/Zeus-0.1.0-arm64.dmg',
      zipPath: 'dist/Zeus-0.1.0-arm64.zip',
      caskPath: 'dist/homebrew/zeus.rb',
      caskSha256: 'real-sha',
      signed: false,
      notarized: false,
      statusLabel: 'unsigned DMG/ZIP',
    });
  });

  it('reports release readiness from real signing and notarization inputs only', () => {
    expect(
      detectReleaseReadiness({
        hasAppleCertificate: false,
        hasNotaryCredentials: false,
      }),
    ).toEqual({
      canBuildUnsignedArtifacts: true,
      canSign: false,
      canNotarize: false,
      waitingFor: ['Apple signing certificate', 'Apple notarization credentials'],
    });

    expect(
      detectReleaseReadiness({
        hasAppleCertificate: true,
        hasNotaryCredentials: true,
      }),
    ).toEqual({
      canBuildUnsignedArtifacts: true,
      canSign: true,
      canNotarize: true,
      waitingFor: [],
    });
  });

  it('builds an explicit manual auto-update policy without pretending a feed is active', () => {
    expect(
      buildAutoUpdatePolicy({
        currentVersion: '0.1.0',
        channel: 'manual',
        hasReleaseWorkflow: true,
        hasSignedAndNotarizedArtifacts: false,
        changelogPath: 'docs/release.md',
      }),
    ).toEqual({
      currentVersion: '0.1.0',
      channel: 'manual',
      checkMode: 'manual',
      updateFeedConfigured: false,
      changelogPath: 'docs/release.md',
      waitingFor: ['signed and notarized artifacts'],
      label: '手动更新 · 0.1.0',
    });
  });

  it('builds a public GitHub release update manifest for install and in-app checks', () => {
    const manifest = buildReleaseUpdateManifest({
      version: '0.2.0',
      channel: 'stable',
      repository: 'imchenway/zeus',
      publishedAt: '2026-06-16T00:00:00.000Z',
      signed: false,
      notarized: false,
      minimumSystemVersion: '13.0',
      artifacts: [
        {
          arch: 'arm64',
          kind: 'dmg',
          fileName: 'Zeus-0.2.0-arm64.dmg',
          sha256: 'arm-dmg-sha',
        },
        {
          arch: 'x64',
          kind: 'zip',
          fileName: 'Zeus-0.2.0-x64.zip',
          sha256: 'x64-zip-sha',
        },
      ],
    });

    expect(manifest).toMatchObject({
      app: 'Zeus',
      schemaVersion: 1,
      version: '0.2.0',
      channel: 'stable',
      repository: 'imchenway/zeus',
      releasePageUrl: 'https://github.com/imchenway/zeus/releases/tag/v0.2.0',
      latestReleaseUrl: 'https://github.com/imchenway/zeus/releases/latest',
      installScriptUrl: 'https://github.com/imchenway/zeus/releases/latest/download/install.sh',
      signed: false,
      notarized: false,
      minimumSystemVersion: '13.0',
      homebrew: {
        tap: 'imchenway/zeus',
        cask: 'zeus',
        installCommand: 'brew install --cask imchenway/zeus/zeus',
        upgradeCommand: 'brew upgrade --cask zeus',
      },
    });
    expect(manifest.artifacts).toEqual([
      expect.objectContaining({
        arch: 'arm64',
        kind: 'dmg',
        downloadUrl: 'https://github.com/imchenway/zeus/releases/download/v0.2.0/Zeus-0.2.0-arm64.dmg',
      }),
      expect.objectContaining({
        arch: 'x64',
        kind: 'zip',
        downloadUrl: 'https://github.com/imchenway/zeus/releases/download/v0.2.0/Zeus-0.2.0-x64.zip',
      }),
    ]);
  });

  it('evaluates update availability without enabling silent installs for unsigned artifacts', () => {
    const manifest = buildReleaseUpdateManifest({
      version: '0.2.0',
      channel: 'stable',
      repository: 'imchenway/zeus',
      signed: false,
      notarized: false,
      artifacts: [
        {
          arch: 'arm64',
          kind: 'dmg',
          fileName: 'Zeus-0.2.0-arm64.dmg',
          sha256: 'arm-dmg-sha',
        },
      ],
    });

    expect(
      evaluateReleaseUpdateAvailability({
        currentVersion: '0.1.0',
        manifest,
        platformArch: 'arm64',
        checkedAt: '2026-06-16T01:00:00.000Z',
      }),
    ).toEqual(
      expect.objectContaining({
        status: 'available',
        currentVersion: '0.1.0',
        latestVersion: '0.2.0',
        channel: 'stable',
        recommendedAction: 'open_download_page',
        automaticInstallEnabled: false,
        reason: '发现新版本，但当前产物未同时签名和公证，只允许打开 GitHub Release 手动安装。',
      }),
    );

    expect(
      evaluateReleaseUpdateAvailability({
        currentVersion: '0.2.0',
        manifest,
        platformArch: 'arm64',
        checkedAt: '2026-06-16T01:00:00.000Z',
      }),
    ).toEqual(
      expect.objectContaining({
        status: 'up_to_date',
        recommendedAction: 'none',
        automaticInstallEnabled: false,
      }),
    );

    const signedManifest = { ...manifest, signed: true, notarized: true };
    expect(
      evaluateReleaseUpdateAvailability({
        currentVersion: '0.1.0',
        manifest: signedManifest,
        platformArch: 'arm64',
        checkedAt: '2026-06-16T01:00:00.000Z',
      }),
    ).toEqual(
      expect.objectContaining({
        status: 'available',
        recommendedAction: 'download_and_install',
        automaticInstallEnabled: true,
        reason: '发现新版本，产物已签名并公证，可下载后安装。',
      }),
    );
  });

  it('builds an install script plan with public latest-release entrypoints and documented environment flags', () => {
    expect(
      buildInstallScriptPlan({
        repository: 'imchenway/zeus',
        channel: 'stable',
      }),
    ).toEqual({
      repository: 'imchenway/zeus',
      channel: 'stable',
      installUrl: 'https://github.com/imchenway/zeus/releases/latest/download/install.sh',
      supportedEnvironmentVariables: ['ZEUS_NON_INTERACTIVE', 'ZEUS_INSTALL_DIR', 'ZEUS_CHANNEL'],
      defaultInstallDir: '/Applications',
      command: 'curl -fsSL https://github.com/imchenway/zeus/releases/latest/download/install.sh | bash',
    });
  });
});
