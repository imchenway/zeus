/** Zeus 可可靠识别并交给语法解析器的源码或文本配置语言。 */
export type SourceLanguageId =
  | 'c'
  | 'cmake'
  | 'cpp'
  | 'css'
  | 'diff'
  | 'dockerfile'
  | 'go'
  | 'html'
  | 'java'
  | 'javascript'
  | 'json'
  | 'jsx'
  | 'kotlin'
  | 'markdown'
  | 'php'
  | 'properties'
  | 'python'
  | 'ruby'
  | 'rust'
  | 'sass'
  | 'scss'
  | 'shell'
  | 'sql'
  | 'swift'
  | 'toml'
  | 'tsx'
  | 'typescript'
  | 'xml'
  | 'yaml';

const languageByExtension: Readonly<Record<string, SourceLanguageId>> = {
  bash: 'shell',
  c: 'c',
  cc: 'cpp',
  cmake: 'cmake',
  cpp: 'cpp',
  css: 'css',
  cxx: 'cpp',
  diff: 'diff',
  dockerfile: 'dockerfile',
  gemspec: 'ruby',
  go: 'go',
  h: 'c',
  hh: 'cpp',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  hxx: 'cpp',
  ini: 'properties',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  markdown: 'markdown',
  md: 'markdown',
  patch: 'diff',
  php: 'php',
  phtml: 'php',
  properties: 'properties',
  py: 'python',
  pyw: 'python',
  rake: 'ruby',
  rb: 'ruby',
  rs: 'rust',
  sass: 'sass',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  svg: 'xml',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell',
};

const languageByFilename: Readonly<Record<string, SourceLanguageId>> = {
  cmakelists: 'cmake',
  'cmakelists.txt': 'cmake',
  dockerfile: 'dockerfile',
  gemfile: 'ruby',
  rakefile: 'ruby',
};

const sourceLanguageIds = new Set<SourceLanguageId>(Object.values(languageByExtension).concat(Object.values(languageByFilename)));

export function isSourceLanguageId(value: unknown): value is SourceLanguageId {
  return typeof value === 'string' && sourceLanguageIds.has(value as SourceLanguageId);
}

/** 只依据文件名识别有可靠解析器支持的类型；未知文本返回 null。 */
export function detectSourceLanguage(path: string): SourceLanguageId | null {
  const normalized = path.replaceAll('\\', '/').toLocaleLowerCase();
  const filename = normalized.split('/').filter(Boolean).at(-1) ?? normalized;
  const exact = languageByFilename[filename];
  if (exact) return exact;
  if (filename.startsWith('dockerfile.')) return 'dockerfile';
  if (filename.endsWith('.dockerfile')) return 'dockerfile';
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === filename.length - 1) return null;
  return languageByExtension[filename.slice(dotIndex + 1)] ?? null;
}
