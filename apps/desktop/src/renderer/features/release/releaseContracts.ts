export interface ConfigurationPresence {
  configured: boolean;
  label: string;
}

export interface ReleaseReadinessSnapshot {
  canBuildUnsignedArtifacts: boolean;
  canSign: boolean;
  canNotarize: boolean;
  waitingFor: string[];
}

export interface AutoUpdatePolicySnapshot {
  currentVersion: string;
  channel: 'manual';
  checkMode: 'manual';
  updateFeedConfigured: boolean;
  changelogPath: string;
  waitingFor: string[];
  label: string;
}

export interface ReleaseStatusSnapshot {
  signing: ConfigurationPresence;
  notarization: ConfigurationPresence;
  homebrewCask: ConfigurationPresence;
  releaseWorkflow: ConfigurationPresence;
  readiness: ReleaseReadinessSnapshot;
  autoUpdate: AutoUpdatePolicySnapshot;
}

export interface ReleaseUpdateArtifactSnapshot {
  arch: 'arm64' | 'x64';
  kind: 'dmg' | 'zip';
  fileName: string;
  sha256: string;
  sizeBytes: number | null;
  downloadUrl: string;
}

export interface ReleaseUpdateStatusSnapshot {
  status: 'up_to_date' | 'available' | 'unavailable';
  currentVersion: string;
  latestVersion: string;
  channel: 'stable' | 'preview';
  releasePageUrl: string;
  artifact: ReleaseUpdateArtifactSnapshot | null;
  executionHostProtocolVersion: number;
  automaticInstallEnabled: boolean;
  recommendedAction: 'none' | 'open_download_page' | 'download_and_install';
  label: string;
  reason: string;
  checkedAt: string;
  executionHost?: {
    instanceId: string | null;
    protocolVersion: number;
    mode: 'embedded' | 'detached';
    pid: number;
    startedAt: string | null;
    transport: {
      state: 'idle' | 'starting' | 'ready' | 'restarting' | 'closed';
      generationId: string | null;
    };
    runtimeGenerations: Array<{
      generationId: string;
      state: 'idle' | 'starting' | 'ready' | 'restarting' | 'closed';
      active: boolean;
      activeThreadCount: number;
      pendingRequestCount: number;
    }>;
    activeTurnCount: number;
    waitingRequestCount: number;
    activeRuntimeCount: number;
    activeCommandRunCount: number;
    hasActiveWork: boolean;
    observedAt: string;
  };
}

export interface ReleaseUpdateOperationSnapshot {
  accepted: boolean;
  update: ReleaseUpdateStatusSnapshot;
  reason: string;
}
