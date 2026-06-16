import { describe, expect, it } from 'vitest';
import { exportPatchToFile } from '../src/main/patchExport.js';

describe('Electron patch export file bridge', () => {
  it('writes a readonly patch payload to a user-selected patch file', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const result = await exportPatchToFile({
      patch: {
        fileName: 'zeus-diff-2026-06-13.patch',
        mimeType: 'text/x-patch',
        patchText: 'diff --git a/README.md b/README.md\n+Zeus\n',
      },
      chooseFile: async () => ({
        canceled: false,
        filePath: '/Users/david/Desktop/zeus-diff.patch',
      }),
      writeTextFile: async (path, content) => {
        writes.push({ path, content });
      },
    });

    expect(result).toEqual({
      saved: true,
      filePath: '/Users/david/Desktop/zeus-diff.patch',
    });
    expect(writes).toEqual([
      {
        path: '/Users/david/Desktop/zeus-diff.patch',
        content: 'diff --git a/README.md b/README.md\n+Zeus\n',
      },
    ]);
  });

  it('rejects non-patch payloads before writing files', async () => {
    await expect(
      exportPatchToFile({
        patch: {
          fileName: 'unsafe.txt',
          mimeType: 'text/plain',
          patchText: 'not a patch',
        },
        chooseFile: async () => ({
          canceled: false,
          filePath: '/Users/david/Desktop/unsafe.txt',
        }),
        writeTextFile: async () => {},
      }),
    ).rejects.toThrow('Zeus patch export requires text/x-patch content');
  });
});
