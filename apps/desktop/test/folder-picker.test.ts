import { describe, expect, it } from 'vitest';
import { chooseProjectDirectory } from '../src/main/projectDirectoryPicker.js';

describe('Electron project directory picker', () => {
  it('returns the selected local directory path', async () => {
    const selected = await chooseProjectDirectory(async () => ({
      canceled: false,
      filePaths: ['/Users/david/hypha/zeus'],
    }));
    expect(selected).toBe('/Users/david/hypha/zeus');
  });

  it('returns null when the user cancels folder selection', async () => {
    const selected = await chooseProjectDirectory(async () => ({
      canceled: true,
      filePaths: [],
    }));
    expect(selected).toBeNull();
  });
});
