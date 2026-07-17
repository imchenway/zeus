export interface ExternalOpenResult {
  opened: boolean;
  url?: string;
  error?: 'external_url_not_allowed' | 'external_url_open_failed';
}

/** Main 进程只接受无凭据的 HTTPS URL；所有其他 scheme 和畸形输入一律拒绝。 */
export function normalizeExternalHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** 在 Main 进程完成第二次 URL 校验后才调用 Electron shell.openExternal。 */
export async function openExternalHttpsUrl(input: { url: unknown; openExternal: (url: string) => Promise<void> }): Promise<ExternalOpenResult> {
  const url = normalizeExternalHttpsUrl(input.url);
  if (!url) return { opened: false, error: 'external_url_not_allowed' };
  try {
    await input.openExternal(url);
    return { opened: true, url };
  } catch {
    return { opened: false, error: 'external_url_open_failed' };
  }
}
