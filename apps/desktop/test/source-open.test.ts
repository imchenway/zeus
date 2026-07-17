import { describe, expect, it, vi } from 'vitest';
import { openGraphSourceLocation } from '../src/main/sourceOpen.js';

describe('Electron graph source opening', () => {
  it('opens only real source files inside the configured project root', async () => {
    const openPath = vi.fn().mockResolvedValue('');

    await expect(
      openGraphSourceLocation({
        projectRoot: '/Users/david/hypha/zeus',
        source: {
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          lineStart: 42,
        },
        fileExists: async () => true,
        openPath,
      }),
    ).resolves.toEqual({
      opened: true,
      filePath: '/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx',
      lineStart: 42,
    });

    expect(openPath).toHaveBeenCalledWith('/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx');
  });

  it('rejects graph source refs outside the configured project root', async () => {
    await expect(
      openGraphSourceLocation({
        projectRoot: '/Users/david/hypha/zeus',
        source: { sourceRef: '../secrets.env', lineStart: 1 },
        fileExists: async () => true,
        openPath: vi.fn(),
      }),
    ).rejects.toThrow('Graph source must stay inside the project root');
  });

  it('opens project graph sources against the selected project root instead of the global Zeus root', async () => {
    const openPath = vi.fn().mockResolvedValue('');

    await expect(
      openGraphSourceLocation({
        projectRoot: '/Users/david/hypha/zeus',
        source: {
          projectRoot: '/Users/david/cckg/tcapp/Back-End/tc-app-core',
          sourceRef: 'src/main/java/com/example/InventoryService.java',
          lineStart: 12,
        },
        fileExists: async () => true,
        openPath,
      }),
    ).resolves.toEqual({
      opened: true,
      filePath: '/Users/david/cckg/tcapp/Back-End/tc-app-core/src/main/java/com/example/InventoryService.java',
      lineStart: 12,
    });

    expect(openPath).toHaveBeenCalledWith('/Users/david/cckg/tcapp/Back-End/tc-app-core/src/main/java/com/example/InventoryService.java');
  });
});
