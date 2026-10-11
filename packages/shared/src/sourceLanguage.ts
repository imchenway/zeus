/** Zeus 可可靠识别并交给语法解析器的源码或文本配置语言。 */
export type SourceLanguageId =
  | 'c'
  | 'cmake'
  | 'cpp'
  | 'csharp'
  | 'groovy'
  | 'lua'
  | 'nginx'
  | 'perl'
  | 'powershell'
  | 'protobuf'
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

/** 常见源码别名映射到已安装解析器，不为每个后缀创建独立语法。 */
const languageByExtension: Readonly<Record<string, SourceLanguageId>> = {
  bash: 'shell',
  cjs: 'javascript',
  mjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  vue: 'html',
  svelte: 'html',
  astro: 'html',
  wxml: 'html',
  wxss: 'css',
  less: 'css',
  xsd: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  plist: 'xml',
  iml: 'xml',
  csproj: 'xml',
  resx: 'xml',
  gradle: 'groovy',
  groovy: 'groovy',
  cs: 'csharp',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  ps1: 'powershell',
  psm1: 'powershell',
  psd1: 'powershell',
  proto: 'protobuf',
  env: 'properties',
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

/** 无扩展名的构建文件和常见配置按完整名称识别。 */
const languageByFilename: Readonly<Record<string, SourceLanguageId>> = {
  '.env': 'properties',
  '.npmrc': 'properties',
  '.editorconfig': 'properties',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.zshrc': 'shell',
  '.zprofile': 'shell',
  'nginx.conf': 'nginx',
  makefile: 'shell',
  gnumakefile: 'shell',
  cmakelists: 'cmake',
  'cmakelists.txt': 'cmake',
  dockerfile: 'dockerfile',
  gemfile: 'ruby',
  rakefile: 'ruby',
};

/** 所有可加载语言都来自上述实际解析器映射。 */
const sourceLanguageIds = new Set<SourceLanguageId>(Object.values(languageByExtension).concat(Object.values(languageByFilename)));

/** 手动选择仅展示当前已经支持的语言。 */
export const sourceLanguageOptions = [...sourceLanguageIds].sort();

/** 校验语言身份，防止未经登记的动态模块加载。 */
export function isSourceLanguageId(value: unknown): value is SourceLanguageId {
  return typeof value === 'string' && sourceLanguageIds.has(value as SourceLanguageId);
}

/** 文件名优先；未知后缀只按明确的 XML 头或脚本 shebang 兜底。 */
export function detectSourceLanguage(path: string, content?: string): SourceLanguageId | null {
  const normalized = path.replaceAll('\\', '/').toLocaleLowerCase();
  const filename = normalized.split('/').filter(Boolean).at(-1) ?? normalized;
  const exact = languageByFilename[filename];
  if (exact) return exact;
  if (filename.startsWith('.env.')) return 'properties';
  if (filename.startsWith('dockerfile.')) return 'dockerfile';
  if (filename.endsWith('.dockerfile')) return 'dockerfile';
  const dotIndex = filename.lastIndexOf('.');
  const extension = dotIndex >= 0 ? languageByExtension[filename.slice(dotIndex + 1)] : undefined;
  if (extension) return extension;
  /** 只检查文件头，不为普通文本猜测复杂语法。 */
  const header = content?.slice(0, 256).trimStart() ?? '';
  if (header.startsWith('<?xml')) return 'xml';
  if (header.startsWith('#!')) {
    const interpreter = header.split('\n', 1)[0]?.match(/\b(python[\d.]*|node|bash|sh|zsh|ruby|perl|pwsh)\b/u)?.[1];
    if (interpreter?.startsWith('python')) return 'python';
    if (interpreter === 'node') return 'javascript';
    if (interpreter === 'ruby') return 'ruby';
    if (interpreter === 'perl') return 'perl';
    if (interpreter === 'pwsh') return 'powershell';
    if (interpreter) return 'shell';
  }
  return null;
}
