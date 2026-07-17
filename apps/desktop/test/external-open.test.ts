import { describe, expect, it, vi } from 'vitest';
import { normalizeExternalHttpsUrl, openExternalHttpsUrl } from '../src/main/externalOpen.js';

describe('audited external HTTPS opening', () => {
  it('normalizes only credential-free HTTPS URLs', () => {
    expect(normalizeExternalHttpsUrl('https://example.com/authorize?state=1')).toBe('https://example.com/authorize?state=1');
    expect(normalizeExternalHttpsUrl('http://example.com/authorize')).toBeNull();
    expect(normalizeExternalHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeExternalHttpsUrl('https://user:secret@example.com/authorize')).toBeNull();
    expect(normalizeExternalHttpsUrl('not a url')).toBeNull();
  });

  it('calls the injected shell opener only after Main validation', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);

    await expect(openExternalHttpsUrl({ url: 'https://example.com/authorize', openExternal })).resolves.toEqual({ opened: true, url: 'https://example.com/authorize' });
    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith('https://example.com/authorize');

    openExternal.mockClear();
    await expect(openExternalHttpsUrl({ url: 'file:///tmp/secret', openExternal })).resolves.toEqual({ opened: false, error: 'external_url_not_allowed' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('returns a bounded failure when the operating system rejects the open request', async () => {
    const openExternal = vi.fn().mockRejectedValue(new Error('sensitive operating-system detail'));

    await expect(openExternalHttpsUrl({ url: 'https://example.com/authorize', openExternal })).resolves.toEqual({ opened: false, error: 'external_url_open_failed' });
  });
});
