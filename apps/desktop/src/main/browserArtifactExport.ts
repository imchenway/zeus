/** Browser 导出制品名称只保留可安全落盘的可打印字符。 */
export function sanitizeBrowserArtifactName(value: string, fallback: string): string {
  const printable = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 || '/\\:'.includes(character) ? '-' : character;
    })
    .join('');
  const normalized = printable
    .normalize('NFKC')
    .replace(/^\.+|\.+$/gu, '')
    .trim()
    .slice(0, 160);
  return normalized || fallback;
}

/** 只把已知的 Google Workspace 文档 URL 投影为官方导出端点。 */
export function googleWorkspaceExportRequest(urlValue: string, type: string): { url: string; extension: string } | null {
  let source: URL;
  try {
    source = new URL(urlValue);
  } catch {
    return null;
  }
  if (source.protocol !== 'https:' || source.hostname !== 'docs.google.com') return null;
  const match = source.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([^/]+)/u);
  if (!match) return null;
  const [, kind, id] = match;
  const formats: Record<string, Record<string, string>> = {
    document: { pdf: 'pdf', docx: 'docx', md: 'txt' },
    spreadsheets: { pdf: 'pdf', xlsx: 'xlsx', csv: 'csv' },
    presentation: { pdf: 'pdf', pptx: 'pptx' },
  };
  const format = formats[kind!]?.[type];
  if (!format) return null;
  const target = new URL(`https://docs.google.com/${kind}/d/${encodeURIComponent(id!)}/export`);
  target.searchParams.set('format', format);
  const resourceKey = source.searchParams.get('resourcekey');
  if (resourceKey) target.searchParams.set('resourcekey', resourceKey);
  return { url: target.toString(), extension: type };
}
