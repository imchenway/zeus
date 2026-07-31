import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const releaseInstallerProtocolVersion = 1;

export interface ReleaseInstallerBootstrap {
  protocolVersion: number;
  transactionId: string;
  mainPid: number;
  targetAppPath: string;
  stagedAppPath: string;
  backupAppPath: string;
  executableRelativePath: string;
  userDataPath: string;
  previousAppVersion: string;
  expectedAppVersion: string;
  testMode: boolean;
  createdAt: string;
}

export interface ReleaseInstallerResult {
  transactionId: string;
  status: 'ready' | 'installing' | 'completed' | 'rolled_back' | 'failed';
  message: string;
  updatedAt: string;
}

export function releaseUpdateDirectory(userDataPath: string): string {
  return join(userDataPath, 'updates');
}

export function releaseInstallerResultPath(userDataPath: string, transactionId: string): string {
  return join(releaseUpdateDirectory(userDataPath), `installer-${transactionId}.json`);
}

export async function writeReleaseInstallerBootstrap(userDataPath: string, input: ReleaseInstallerBootstrap): Promise<string> {
  const directory = releaseUpdateDirectory(userDataPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, `installer-bootstrap-${input.transactionId}-${randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify(input)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return path;
}

export async function readReleaseInstallerBootstrap(path: string): Promise<ReleaseInstallerBootstrap> {
  const value = JSON.parse(await readSecureJson(path)) as unknown;
  if (!isReleaseInstallerBootstrap(value)) throw new Error('Zeus release installer bootstrap is invalid.');
  return value;
}

export async function writeReleaseInstallerResult(userDataPath: string, result: ReleaseInstallerResult): Promise<void> {
  const directory = releaseUpdateDirectory(userDataPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = releaseInstallerResultPath(userDataPath, result.transactionId);
  const temporary = join(directory, `.installer-${result.transactionId}-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

async function readSecureJson(path: string): Promise<string> {
  const fileStat = await lstat(path);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('Zeus release installer metadata must be a regular file.');
  if ((fileStat.mode & 0o077) !== 0) throw new Error('Zeus release installer metadata permissions are too broad.');
  if (typeof process.getuid === 'function' && fileStat.uid !== process.getuid()) throw new Error('Zeus release installer metadata owner does not match the current user.');
  return readFile(path, 'utf8');
}

function isReleaseInstallerBootstrap(value: unknown): value is ReleaseInstallerBootstrap {
  return (
    isRecord(value) &&
    value.protocolVersion === releaseInstallerProtocolVersion &&
    isNonEmptyString(value.transactionId) &&
    Number.isInteger(value.mainPid) &&
    Number(value.mainPid) > 0 &&
    isAbsoluteString(value.targetAppPath) &&
    isAbsoluteString(value.stagedAppPath) &&
    isAbsoluteString(value.backupAppPath) &&
    isNonEmptyString(value.executableRelativePath) &&
    !isAbsolute(value.executableRelativePath) &&
    !value.executableRelativePath.split(/[\\/]/u).includes('..') &&
    isAbsoluteString(value.userDataPath) &&
    isNonEmptyString(value.previousAppVersion) &&
    isNonEmptyString(value.expectedAppVersion) &&
    typeof value.testMode === 'boolean' &&
    isNonEmptyString(value.createdAt)
  );
}

function isAbsoluteString(value: unknown): value is string {
  return isNonEmptyString(value) && isAbsolute(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
