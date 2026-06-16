import { describe, expect, it } from 'vitest';
import { createDefaultProjectConfig, normalizeProjectConfig } from '../src/index.js';

describe('project-core project config', () => {
  it('creates the design-book default project configuration without external availability claims', () => {
    expect(createDefaultProjectConfig('project-1')).toEqual({
      projectId: 'project-1',
      defaultModel: null,
      defaultWorkMode: 'plan',
      defaultTaskPrompt: '',
      scan: {
        ignoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
        indexScope: 'project',
      },
      language: { primary: 'typescript', additional: [] },
      dependencies: { packageManagers: [], manifestPaths: [] },
      vcs: { isGitRepository: false, gitRoot: null },
      database: { connectionName: null, schemaPaths: [] },
      telegram: { alias: null },
      security: { allowShell: false, allowGitWrite: false },
    });
  });

  it('normalizes saved project preferences and rejects unsafe paths or control text', () => {
    const fallback = createDefaultProjectConfig('project-1');
    const normalized = normalizeProjectConfig(
      'project-1',
      {
        defaultModel: ' claude-sonnet ',
        defaultWorkMode: 'develop',
        defaultTaskPrompt: ' 只基于真实代码执行 ',
        scan: {
          ignoreDirectories: ['dist', 'node_modules', 'dist'],
          indexScope: 'src',
        },
        language: { primary: 'Java', additional: ['SQL', 'java'] },
        dependencies: {
          packageManagers: ['pnpm', 'maven', 'pnpm'],
          manifestPaths: ['package.json', 'pom.xml'],
        },
        database: {
          connectionName: ' local-sqlite ',
          schemaPaths: ['schema/init.sql'],
        },
        telegram: { alias: ' zeus-prod ' },
        security: { allowShell: true, allowGitWrite: false },
      },
      fallback,
    );

    expect(normalized).toEqual({
      ...fallback,
      defaultModel: 'claude-sonnet',
      defaultWorkMode: 'develop',
      defaultTaskPrompt: '只基于真实代码执行',
      scan: { ignoreDirectories: ['dist', 'node_modules'], indexScope: 'src' },
      language: { primary: 'java', additional: ['sql', 'java'] },
      dependencies: {
        packageManagers: ['pnpm', 'maven'],
        manifestPaths: ['package.json', 'pom.xml'],
      },
      vcs: { isGitRepository: false, gitRoot: null },
      database: {
        connectionName: 'local-sqlite',
        schemaPaths: ['schema/init.sql'],
      },
      telegram: { alias: 'zeus-prod' },
      security: { allowShell: true, allowGitWrite: false },
    });

    expect(normalizeProjectConfig('project-1', { dependencies: { manifestPaths: ['../secret.env'] } }, fallback)).toBeNull();
    expect(normalizeProjectConfig('project-1', { defaultTaskPrompt: 'bad\u0000prompt' }, fallback)).toBeNull();
  });

  it('preserves the detected Git root when saving editable preferences without VCS input', () => {
    const fallback = {
      ...createDefaultProjectConfig('project-1'),
      vcs: { isGitRepository: true, gitRoot: '/Users/david/hypha/zeus' },
    };

    expect(
      normalizeProjectConfig(
        'project-1',
        {
          defaultWorkMode: 'debug',
          scan: { ignoreDirectories: ['node_modules'], indexScope: 'src' },
        },
        fallback,
      ),
    ).toMatchObject({
      defaultWorkMode: 'debug',
      vcs: { isGitRepository: true, gitRoot: '/Users/david/hypha/zeus' },
    });
  });
});
