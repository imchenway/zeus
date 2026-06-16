import { describe, expect, it } from 'vitest';
import { buildGitPatchExport, getGitDiff, parseGitUnifiedDiff } from '../src/index.js';

describe('Git diff', () => {
  it('reads current repository diff without mutating files', async () => {
    const diff = await getGitDiff('/Users/david/hypha/zeus');
    expect(diff.isRepository).toBe(true);
    expect(Array.isArray(diff.files)).toBe(true);
    expect(typeof diff.diffText).toBe('string');
    expect(Array.isArray(diff.fileDiffs)).toBe(true);
  });

  it('parses unified diff into file hunks and line-level review records', () => {
    const fileDiffs = parseGitUnifiedDiff(
      [
        'diff --git a/apps/desktop/src/renderer/App.tsx b/apps/desktop/src/renderer/App.tsx',
        'index 1111111..2222222 100644',
        '--- a/apps/desktop/src/renderer/App.tsx',
        '+++ b/apps/desktop/src/renderer/App.tsx',
        '@@ -10,2 +10,3 @@ export function App() {',
        ' const title = "Zeus";',
        '-const oldLabel = "Diff";',
        '+const newLabel = "Git Diff";',
        '+const status = "review";',
      ].join('\n'),
    );

    expect(fileDiffs).toEqual([
      {
        oldPath: 'apps/desktop/src/renderer/App.tsx',
        newPath: 'apps/desktop/src/renderer/App.tsx',
        changeType: 'modified',
        addedLines: 2,
        deletedLines: 1,
        hunks: [
          {
            header: '@@ -10,2 +10,3 @@ export function App() {',
            oldStart: 10,
            oldLines: 2,
            newStart: 10,
            newLines: 3,
            lines: [
              {
                type: 'context',
                content: 'const title = "Zeus";',
                oldLineNumber: 10,
                newLineNumber: 10,
              },
              {
                type: 'deletion',
                content: 'const oldLabel = "Diff";',
                oldLineNumber: 11,
                newLineNumber: null,
              },
              {
                type: 'addition',
                content: 'const newLabel = "Git Diff";',
                oldLineNumber: null,
                newLineNumber: 11,
              },
              {
                type: 'addition',
                content: 'const status = "review";',
                oldLineNumber: null,
                newLineNumber: 12,
              },
            ],
          },
        ],
      },
    ]);
  });

  it('detects added, deleted and renamed file diffs without executing git writes', () => {
    const fileDiffs = parseGitUnifiedDiff(
      [
        'diff --git a/old.ts b/new.ts',
        'similarity index 90%',
        'rename from old.ts',
        'rename to new.ts',
        '--- a/old.ts',
        '+++ b/new.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git a/empty.ts b/empty.ts',
        'deleted file mode 100644',
        '--- a/empty.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-gone',
      ].join('\n'),
    );

    expect(
      fileDiffs.map((file) => ({
        oldPath: file.oldPath,
        newPath: file.newPath,
        changeType: file.changeType,
      })),
    ).toEqual([
      { oldPath: 'old.ts', newPath: 'new.ts', changeType: 'renamed' },
      { oldPath: 'empty.ts', newPath: 'empty.ts', changeType: 'deleted' },
    ]);
  });

  it('builds a readonly patch export from a real diff summary', () => {
    const patch = buildGitPatchExport({
      isRepository: true,
      files: ['apps/desktop/src/renderer/App.tsx'],
      diffText: 'diff --git a/apps/desktop/src/renderer/App.tsx b/apps/desktop/src/renderer/App.tsx\n+Zeus\n',
      fileDiffs: [],
    });

    expect(patch.fileName).toMatch(/^zeus-diff-.*\.patch$/u);
    expect(patch.mimeType).toBe('text/x-patch');
    expect(patch.patchText).toContain('diff --git');
    expect(patch.patchText).toContain('apps/desktop/src/renderer/App.tsx');
  });
});
