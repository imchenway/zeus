import { describe, expect, it } from 'vitest';
import { getGitStatus, parseGitPorcelainStatus } from '../src/index.js';

describe('Git status', () => {
  it('reads the current Zeus repository git state without mutating it', async () => {
    const status = await getGitStatus('/Users/david/hypha/zeus');
    expect(status.isRepository).toBe(true);
    expect(status.branch.length).toBeGreaterThan(0);
    expect(Array.isArray(status.fileStatuses)).toBe(true);
    expect(Array.isArray(status.remoteBranches)).toBe(true);
    expect(Array.isArray(status.recentCommits)).toBe(true);
    expect(typeof status.clean).toBe('boolean');
  });

  it('classifies porcelain status into added, modified, deleted, renamed, untracked and conflict files', () => {
    const parsed = parseGitPorcelainStatus(['A  packages/new-file.ts', ' M packages/modified.ts', ' D packages/deleted.ts', 'R  packages/old.ts -> packages/new.ts', '?? docs/new-note.md', 'UU packages/conflict.ts'].join('\n'));

    expect(parsed.changedFiles).toEqual(['packages/new-file.ts', 'packages/modified.ts', 'packages/deleted.ts', 'packages/new.ts', 'docs/new-note.md', 'packages/conflict.ts']);
    expect(parsed.conflictFiles).toEqual(['packages/conflict.ts']);
    expect(parsed.fileStatuses).toEqual([
      {
        path: 'packages/new-file.ts',
        indexStatus: 'A',
        workingTreeStatus: ' ',
        category: 'added',
      },
      {
        path: 'packages/modified.ts',
        indexStatus: ' ',
        workingTreeStatus: 'M',
        category: 'modified',
      },
      {
        path: 'packages/deleted.ts',
        indexStatus: ' ',
        workingTreeStatus: 'D',
        category: 'deleted',
      },
      {
        path: 'packages/new.ts',
        originalPath: 'packages/old.ts',
        indexStatus: 'R',
        workingTreeStatus: ' ',
        category: 'renamed',
      },
      {
        path: 'docs/new-note.md',
        indexStatus: '?',
        workingTreeStatus: '?',
        category: 'untracked',
      },
      {
        path: 'packages/conflict.ts',
        indexStatus: 'U',
        workingTreeStatus: 'U',
        category: 'conflict',
      },
    ]);
  });
});
