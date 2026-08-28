import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTestDataRootIsolation } from '../apps/desktop/src/main/testDataRootIsolation.js';

const root = await mkdtemp(join(tmpdir(), 'zeus-test-root-isolation-'));
const canonicalRoot = await realpath(root);
const homeDirectory = join(root, 'home');
const appDataDirectory = join(homeDirectory, 'Library', 'Application Support');
const formalRoot = join(homeDirectory, '.zeus');
await mkdir(formalRoot, { recursive: true });
await mkdir(appDataDirectory, { recursive: true });

const isolated = assertTestDataRootIsolation({
  requestedRoot: join(root, 'isolated', 'task-a'),
  homeDirectory,
  appDataDirectory,
});
assert.equal(isolated, join(canonicalRoot, 'isolated', 'task-a'));

for (const requestedRoot of [formalRoot, join(formalRoot, 'nested'), homeDirectory, join(appDataDirectory, '@zeus'), join(appDataDirectory, 'Zeus', 'nested')]) {
  assert.throws(
    () => assertTestDataRootIsolation({ requestedRoot, homeDirectory, appDataDirectory }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ZEUS_TEST_DATA_ROOT_NOT_ISOLATED',
  );
}

const alias = join(root, 'formal-alias');
await symlink(formalRoot, alias);
assert.throws(
  () => assertTestDataRootIsolation({ requestedRoot: alias, homeDirectory, appDataDirectory }),
  (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ZEUS_TEST_DATA_ROOT_NOT_ISOLATED',
);

process.stdout.write('Zeus Test data-root isolation behavior verified: isolated roots pass; formal, ancestor, descendant and symlink aliases fail closed.\n');
