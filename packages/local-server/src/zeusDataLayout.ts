import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export type ZeusDataOwner = 'zeus' | 'electron' | 'browser' | 'provider';
export type ZeusDataLifecycle = 'core' | 'managed' | 'backup' | 'cache' | 'runtime';
export type ZeusDataLayoutKind = 'layered' | 'legacy-flat';

export interface ZeusDataPathDescriptor {
  key: ZeusDataPathKey;
  path: string;
  owner: ZeusDataOwner;
  lifecycle: ZeusDataLifecycle;
  reconstructible: boolean;
  userClearable: boolean;
  clearEffect: string | null;
}

export type ZeusDataPathKey =
  | 'database'
  | 'localConfig'
  | 'localLogs'
  | 'taskAttachments'
  | 'conversationAttachments'
  | 'browserComments'
  | 'browserDownloads'
  | 'turnChangeSets'
  | 'runtimeSessions'
  | 'commandScripts'
  | 'commandRuns'
  | 'codexHome'
  | 'piConfig'
  | 'piSessions'
  | 'codexLegacyImports'
  | 'codexConfigImportBackups'
  | 'databaseMigrationBackup'
  | 'executionHost'
  | 'releaseUpdates'
  | 'electronNetworkCache'
  | 'browserProfile';

export interface ZeusDataLayout {
  kind: ZeusDataLayoutKind;
  root: string;
  dataDirectory: string;
  artifactsDirectory: string;
  providersDirectory: string;
  backupsDirectory: string;
  runtimeDirectory: string;
  profileDirectory: string;
  electronUserData: string;
  migrationState: string;
  migrationQuarantine: string;
  database: string;
  localConfig: string;
  localLogs: string;
  taskAttachments: string;
  conversationAttachments: string;
  conversationAttachmentGrantSecret: string;
  browserComments: string;
  browserDownloads: string;
  browserState: string;
  turnChangeSets: string;
  runtimeSessions: string;
  commandScripts: string;
  commandRuns: string;
  codexHome: string;
  piConfig: string;
  piSessions: string;
  codexLegacyImports: string;
  codexConfigImportBackups: string;
  databaseBackups: string;
  databaseMigrationBackup: string;
  executionHost: string;
  releaseUpdates: string;
  electronNetworkCache: string;
  browserProfile: string;
  entries: readonly ZeusDataPathDescriptor[];
}

/**
 * 创建分层目录布局。顶层只表达六类稳定边界，业务模块不得自行在根目录新增文件。
 */
export function createZeusDataLayout(rootPath: string): ZeusDataLayout {
  const root = normalizeRoot(rootPath);
  const dataDirectory = join(root, 'data');
  const artifactsDirectory = join(root, 'artifacts');
  const providersDirectory = join(root, 'providers');
  const backupsDirectory = join(root, 'backups');
  const runtimeDirectory = join(root, 'runtime');
  const profileDirectory = join(root, 'profile');
  const electronUserData = join(profileDirectory, 'electron');
  const database = join(dataDirectory, 'zeus.db');
  return finalizeLayout({
    kind: 'layered',
    root,
    dataDirectory,
    artifactsDirectory,
    providersDirectory,
    backupsDirectory,
    runtimeDirectory,
    profileDirectory,
    electronUserData,
    migrationState: join(runtimeDirectory, 'migrations'),
    migrationQuarantine: join(runtimeDirectory, 'quarantine'),
    database,
    localConfig: join(dataDirectory, 'zeus.config.json'),
    localLogs: join(dataDirectory, 'logs', 'local-server'),
    taskAttachments: join(artifactsDirectory, 'task-attachments'),
    conversationAttachments: join(artifactsDirectory, 'conversation-attachments'),
    conversationAttachmentGrantSecret: join(dataDirectory, 'conversation-attachment-grant.secret'),
    browserComments: join(artifactsDirectory, 'browser-comments'),
    browserDownloads: join(artifactsDirectory, 'browser-downloads'),
    browserState: join(profileDirectory, 'browser', 'state.json'),
    turnChangeSets: join(artifactsDirectory, 'turn-change-sets'),
    runtimeSessions: join(artifactsDirectory, 'runtime-sessions'),
    commandScripts: join(artifactsDirectory, 'command-scripts'),
    commandRuns: join(artifactsDirectory, 'command-runs'),
    codexHome: join(providersDirectory, 'codex'),
    piConfig: join(providersDirectory, 'pi', 'config'),
    piSessions: join(providersDirectory, 'pi', 'sessions'),
    codexLegacyImports: join(backupsDirectory, 'imports', 'codex-legacy'),
    codexConfigImportBackups: join(backupsDirectory, 'imports', 'codex'),
    databaseBackups: join(backupsDirectory, 'database'),
    databaseMigrationBackup: join(backupsDirectory, 'database', 'zeus.db.pre-native-sqlite.bak'),
    executionHost: join(runtimeDirectory, 'execution-host'),
    releaseUpdates: join(runtimeDirectory, 'updates'),
    electronNetworkCache: join(electronUserData, 'Cache'),
    browserProfile: join(electronUserData, 'Partitions'),
  });
}

/**
 * 旧平铺布局只供升级期间连接尚未退出的旧执行宿主，不得用于初始化新资料目录。
 */
export function createLegacyFlatZeusDataLayout(rootPath: string): ZeusDataLayout {
  const root = normalizeRoot(rootPath);
  const database = join(root, 'zeus.db');
  return finalizeLayout({
    kind: 'legacy-flat',
    root,
    dataDirectory: root,
    artifactsDirectory: root,
    providersDirectory: join(root, 'agent-runtimes'),
    backupsDirectory: root,
    runtimeDirectory: root,
    profileDirectory: root,
    electronUserData: root,
    migrationState: join(root, '.layout-migrations'),
    migrationQuarantine: join(root, '.layout-quarantine'),
    database,
    localConfig: join(root, 'zeus.config.json'),
    localLogs: `${database}.logs`,
    taskAttachments: join(root, 'task-attachments'),
    conversationAttachments: join(root, 'conversation-attachments'),
    conversationAttachmentGrantSecret: join(root, 'conversation-attachment-grant.secret'),
    browserComments: join(root, 'browser-comments'),
    browserDownloads: join(root, 'browser-downloads'),
    browserState: join(root, 'browser-state.json'),
    turnChangeSets: join(root, 'turn-change-sets'),
    runtimeSessions: join(root, 'sessions'),
    commandScripts: join(root, 'command-scripts'),
    commandRuns: join(root, 'command-runs'),
    codexHome: join(root, 'agent-runtimes', 'codex'),
    piConfig: join(root, 'agent-runtimes', 'pi', 'config'),
    piSessions: join(root, 'agent-runtimes', 'pi', 'sessions'),
    codexLegacyImports: join(root, 'codex-legacy-import'),
    codexConfigImportBackups: join(root, 'imports', 'codex'),
    databaseBackups: root,
    databaseMigrationBackup: join(root, 'zeus.db.pre-native-sqlite.bak'),
    executionHost: join(root, 'execution-host'),
    releaseUpdates: join(root, 'updates'),
    electronNetworkCache: join(root, 'Cache'),
    browserProfile: join(root, 'Partitions'),
  });
}

/** 根据数据库路径恢复所属布局，供未显式传入登记表的底层调用兼容使用。 */
export function createZeusDataLayoutForDatabase(databasePath: string): ZeusDataLayout {
  const absolute = resolve(databasePath);
  if (basename(dirname(absolute)) === 'data') return createZeusDataLayout(dirname(dirname(absolute)));
  return createLegacyFlatZeusDataLayout(dirname(absolute));
}

function normalizeRoot(rootPath: string): string {
  if (!isAbsolute(rootPath)) throw new Error('Zeus 数据根目录必须是绝对路径。');
  return resolve(rootPath);
}

function finalizeLayout(layout: Omit<ZeusDataLayout, 'entries'>): ZeusDataLayout {
  const entry = (key: ZeusDataPathKey, owner: ZeusDataOwner, lifecycle: ZeusDataLifecycle, reconstructible: boolean, userClearable: boolean, clearEffect: string | null): ZeusDataPathDescriptor => ({
    key,
    path: layout[key],
    owner,
    lifecycle,
    reconstructible,
    userClearable,
    clearEffect,
  });
  return {
    ...layout,
    entries: [
      entry('database', 'zeus', 'core', false, false, null),
      entry('localConfig', 'zeus', 'core', false, false, null),
      entry('localLogs', 'zeus', 'managed', false, false, null),
      entry('taskAttachments', 'zeus', 'managed', false, false, null),
      entry('conversationAttachments', 'zeus', 'managed', false, false, null),
      entry('browserComments', 'browser', 'managed', false, false, null),
      entry('browserDownloads', 'browser', 'managed', false, false, null),
      entry('turnChangeSets', 'zeus', 'managed', false, false, null),
      entry('runtimeSessions', 'zeus', 'managed', false, false, null),
      entry('commandScripts', 'zeus', 'managed', false, false, null),
      entry('commandRuns', 'zeus', 'runtime', true, false, null),
      entry('codexHome', 'provider', 'managed', false, false, null),
      entry('piConfig', 'provider', 'managed', false, false, null),
      entry('piSessions', 'provider', 'managed', false, false, null),
      entry('codexLegacyImports', 'provider', 'backup', false, false, null),
      entry('codexConfigImportBackups', 'zeus', 'backup', false, false, null),
      entry('databaseMigrationBackup', 'zeus', 'backup', false, false, null),
      entry('executionHost', 'zeus', 'runtime', true, false, null),
      entry('releaseUpdates', 'zeus', 'runtime', true, false, null),
      entry('electronNetworkCache', 'electron', 'cache', true, true, '会重新下载网页与接口缓存，但不会退出登录或清除站点授权。'),
      entry('browserProfile', 'browser', 'managed', false, false, '清除会退出网站登录并移除站点授权，必须使用独立的高影响操作。'),
    ],
  };
}
