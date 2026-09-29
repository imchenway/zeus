/** 读取 Skill frontmatter 的单值字段，并兼容 YAML 折叠与保留换行块。 */
export function skillFrontmatterScalar(markdown: string, key: string): string | null {
  /** 统一换行后再定位 frontmatter 边界。 */
  const normalized = markdown.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) return null;
  /** 结束标记只在开头 frontmatter 内生效。 */
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return null;
  /** 字段解析只读取 frontmatter 行，不扫描正文。 */
  const lines = normalized.slice(4, end).split('\n');
  /** 字段名由调用方提供，只匹配整行键。 */
  const keyPattern = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'u');
  /** 首个同名字段作为权威值。 */
  const lineIndex = lines.findIndex((line) => keyPattern.test(line));
  if (lineIndex < 0) return null;
  /** 行内值保留 YAML 引号和块标记，随后按类型处理。 */
  const raw = keyPattern.exec(lines[lineIndex]!)?.[1]?.trim() ?? '';
  if (/^[>|][+-]?(?:\s+#.*)?$/u.test(raw)) {
    /** 块值只收集后续缩进行。 */
    const blockLines: string[] = [];
    for (let index = lineIndex + 1; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.trim() && !/^\s/u.test(line)) break;
      blockLines.push(line);
    }
    /** 最小公共缩进决定块内容起点。 */
    const nonEmptyIndents = blockLines.filter((line) => line.trim()).map((line) => /^\s*/u.exec(line)?.[0].length ?? 0);
    if (nonEmptyIndents.length === 0) return null;
    /** 按非空行确定公共缩进。 */
    const indentation = Math.min(...nonEmptyIndents);
    /** 移除公共缩进但保留行内内容。 */
    const values = blockLines.map((line) => line.slice(Math.min(indentation, line.length)).trimEnd());
    /** 折叠块合并空白，保留块保留换行。 */
    const value = raw.startsWith('>') ? values.join(' ').replace(/\s+/gu, ' ').trim() : values.join('\n').trim();
    return value || null;
  }
  if (!raw) return null;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      /** 双引号值复用 JSON 字符串转义规则。 */
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'string' ? parsed.trim() : null;
    } catch {
      return null;
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'").trim();
  return raw.replace(/\s+#.*$/u, '').trim();
}
