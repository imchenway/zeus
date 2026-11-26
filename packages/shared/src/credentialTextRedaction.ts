/** 会话预览中的凭据需要遮蔽，同时返回是否发生过遮蔽。 */
export function redactConversationPreviewText(value: string): { text: string; redacted: boolean } {
  /** 可单凭格式识别的私钥和 Token，无需依赖相邻的键名。 */
  const patterns: Array<[RegExp, string]> = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, '[REDACTED_PRIVATE_KEY]'],
    [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/giu, 'Bearer [REDACTED_TOKEN]'],
    [/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED_TOKEN]'],
  ];
  let text = value;
  let redacted = false;
  for (const [pattern, replacement] of patterns) {
    text = text.replace(pattern, () => {
      redacted = true;
      return replacement;
    });
  }
  text = text.replace(/("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)"?\s*[:=]\s*"?)[^"'\s,}]{8,}/giu, (_match, prefix: string) => {
    redacted = true;
    return prefix + '[REDACTED_SECRET]';
  });
  return { text, redacted };
}

/** 运行时文本中的命令行凭据和认证令牌使用相同的遮蔽值。 */
export function redactRuntimeCredentialText(value: string): { text: string; redacted: boolean } {
  let redacted = false;
  /** 任何规则命中时保留遮蔽标记，供诊断记录识别已处理的文本。 */
  const replace = (text: string, pattern: RegExp, replacer: string | ((...args: string[]) => string)): string =>
    text.replace(pattern, (...args: string[]) => {
      redacted = true;
      return typeof replacer === 'string' ? replacer : replacer(...args);
    });
  let text = value;
  text = replace(text, /(\b(?:token|api[-_]?key|secret|password)\s*=\s*)[^\s"']+/giu, (_match, prefix) => prefix + '[REDACTED]');
  text = replace(text, /(--(?:api-key|token|secret|password)\s+)[^\s"']+/giu, (_match, prefix) => prefix + '[REDACTED]');
  text = replace(text, /(\bbearer\s+)(?!or\s+basic\s+authentication\b)[^\s"']+/giu, (_match, prefix) => prefix + '[REDACTED]');
  text = replace(text, /\bsecret-[A-Za-z0-9._-]+/gu, '[REDACTED]');
  return { text, redacted };
}
