import { detectSourceLanguage, type SourceLanguageId } from '@zeus/shared';
import materialFileIcons from './materialFileIcons.json' with { type: 'json' };

/** Zeus 和 Material Icon Theme 对同一种语法使用的不同语言 ID。 */
const languageAliases: Readonly<Partial<Record<SourceLanguageId, string>>> = {
  jsx: 'javascriptreact',
  shell: 'shellscript',
  tsx: 'typescriptreact',
};

/** 只查找映射自有的键，文件名可以和 JavaScript 原型属性同名。 */
function findIcon(associations: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(associations, key) ? associations[key] : undefined;
}

/** 主题名称规则忽略大小写，并接受两端路径分隔符及目录末尾的斜杠。 */
function pathSegments(path: string): string[] {
  return path
    .toLowerCase()
    .split(/[\\/]+/u)
    .filter(Boolean);
}

/** 父目录限定名称比全局名称更具体。 */
function namedIcon(associations: Readonly<Record<string, string>>, segments: readonly string[]): string | undefined {
  /** 名称保留点号和扩展名。 */
  const name = segments.at(-1) ?? '';
  /** 主题只按直接父目录限定名称。 */
  const parent = segments.at(-2);
  return (parent ? findIcon(associations, `${parent}/${name}`) : undefined) ?? findIcon(associations, name);
}

/** 完整文件名优先，复合后缀从长到短匹配，最后使用已识别语言或默认图标。 */
export function materialFileIconName(path: string): string {
  /** 目录限定的文件名优先于普通文件名和后缀。 */
  const segments = pathSegments(path);
  /** 完整文件名规则可以识别没有扩展名的文件。 */
  const exact = namedIcon(materialFileIcons.fileNames, segments);
  if (exact) return exact;

  /** 从完整文件名中拆出各级后缀。 */
  const fileName = segments.at(-1) ?? '';
  for (let dot = fileName.indexOf('.'); dot !== -1; dot = fileName.indexOf('.', dot + 1)) {
    /** 例如从 d.ts 开始匹配，再退到 ts。 */
    const extensionIcon = findIcon(materialFileIcons.fileExtensions, fileName.slice(dot + 1));
    if (extensionIcon) return extensionIcon;
  }

  /** 文件图标复用已有的路径语言识别，无需读取内容。 */
  const language = detectSourceLanguage(path);
  return (language ? findIcon(materialFileIcons.languageIds, languageAliases[language] ?? language) : undefined) ?? materialFileIcons.file;
}

/** 特定目录按名称识别，未知目录使用主题的默认文件夹。 */
export function materialFolderIconName(path: string): string {
  return namedIcon(materialFileIcons.folderNames, pathSegments(path)) ?? materialFileIcons.folder;
}

/** 静态 SVG 与 renderer 的 HTML 一起提供，路径相对于当前入口。 */
export function materialIconUrl(name: string): string {
  return `./file-type-icons/${name}.svg`;
}
