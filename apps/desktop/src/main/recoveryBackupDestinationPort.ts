import { createHash, randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { app, dialog, type BrowserWindow, type OpenDialogOptions } from 'electron';

export interface DesktopRecoveryBackupDestinationGrant {
  grantId: string;
  destinationId: string;
  displayName: string;
}

export interface DesktopRecoveryBackupDestinationSelection {
  cancelled: boolean;
  destinations: DesktopRecoveryBackupDestinationGrant[];
}

interface PrivateDestinationGrant extends DesktopRecoveryBackupDestinationGrant {
  directoryPath: string;
  securityScopedBookmark: string | null;
}

/**
 * Desktop Main 独占持有真实目录与 security-scoped bookmark；Renderer 只得到短期 opaque grantId。
 * 不推断或硬编码任何云盘目录，用户必须通过系统选择器明确选择两个互不相同的目录。
 */
export class ElectronRecoveryBackupDestinationPort {
  private readonly grants = new Map<string, PrivateDestinationGrant>();

  async chooseExactlyTwoDirectories(requestingWindow?: BrowserWindow): Promise<DesktopRecoveryBackupDestinationSelection> {
    const options: OpenDialogOptions = {
      title: '选择两个加密备份目的地',
      buttonLabel: '选择两个目录',
      message: '请选择两个互不相同的目录。Zeus 不会自动查找或绑定 iCloud、Google Drive 等路径。',
      properties: ['openDirectory', 'multiSelections', 'createDirectory'],
      securityScopedBookmarks: process.platform === 'darwin',
    };
    const selected = requestingWindow ? await dialog.showOpenDialog(requestingWindow, options) : await dialog.showOpenDialog(options);
    if (selected.canceled) return { cancelled: true, destinations: [] };
    if (selected.filePaths.length !== 2) throw new Error('必须恰好选择两个备份目录；当前选择数量不符合要求。');
    if (selected.filePaths[0] === selected.filePaths[1]) throw new Error('两个备份目的地不能是同一个目录。');

    const bookmarks = selected.bookmarks ?? [];
    const destinations = selected.filePaths.map((directoryPath, index) => {
      const grant: PrivateDestinationGrant = {
        grantId: randomUUID(),
        // grantId 是短期能力；destinationId 必须跨重启稳定，才能幂等核对已有不可变回执。
        destinationId: stableDestinationId(directoryPath),
        displayName: basename(directoryPath) || `备份目录 ${index + 1}`,
        directoryPath,
        securityScopedBookmark: bookmarks[index] ?? null,
      };
      this.grants.set(grant.grantId, grant);
      return publicGrant(grant);
    });
    return { cancelled: false, destinations };
  }

  async withAccess<T>(
    grantId: string,
    operation: (grant: { destinationId: string; displayName: string; directoryPath: string }) => Promise<T>,
  ): Promise<T> {
    const grant = this.grants.get(grantId);
    if (!grant) throw new Error('备份目录授权不存在或已经释放，请重新通过系统选择器授权。');
    let stopAccessing: (() => void) | undefined;
    if (grant.securityScopedBookmark) {
      const stopSecurityScopedAccess = app.startAccessingSecurityScopedResource(grant.securityScopedBookmark);
      stopAccessing = () => stopSecurityScopedAccess();
    }
    try {
      return await operation({
        destinationId: grant.destinationId,
        displayName: grant.displayName,
        directoryPath: grant.directoryPath,
      });
    } finally {
      stopAccessing?.();
    }
  }

  release(grantId: string): void {
    this.grants.delete(grantId);
  }

  releaseAll(): void {
    this.grants.clear();
  }
}

function stableDestinationId(directoryPath: string): string {
  return createHash('sha256').update('zeus-recovery-destination-v1\0').update(resolve(directoryPath)).digest('hex');
}

function publicGrant(grant: PrivateDestinationGrant): DesktopRecoveryBackupDestinationGrant {
  return {
    grantId: grant.grantId,
    destinationId: grant.destinationId,
    displayName: grant.displayName,
  };
}
