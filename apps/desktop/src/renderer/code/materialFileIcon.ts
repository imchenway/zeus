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

/** 完整文件名优先，复合后缀从长到短匹配，最后使用已识别语言或默认图标。 */
function iconNameForPath(path: string): string {
  /** 路径可能来自 Windows 或 macOS，主题规则对大小写不敏感。 */
  const segments = path.toLowerCase().split(/[\\/]/u);
  /** 文件名是完整名称，包含扩展名和开头的点。 */
  const fileName = segments.at(-1) ?? '';
  /** 主题的路径限定规则使用文件的直接父目录。 */
  const parent = segments.at(-2);
  /** 父目录限定名称比全局名称更具体。 */
  const namedIcon = (parent ? findIcon(materialFileIcons.fileNames, `${parent}/${fileName}`) : undefined) ?? findIcon(materialFileIcons.fileNames, fileName);
  if (namedIcon) return namedIcon;

  for (let dot = fileName.indexOf('.'); dot !== -1; dot = fileName.indexOf('.', dot + 1)) {
    /** 例如从 d.ts 开始匹配，再退到 ts。 */
    const extensionIcon = findIcon(materialFileIcons.fileExtensions, fileName.slice(dot + 1));
    if (extensionIcon) return extensionIcon;
  }

  /** 仅从路径复用 Zeus 已有的语言识别，正文文件链接无需读取文件内容。 */
  const language = detectSourceLanguage(path);
  return (language ? findIcon(materialFileIcons.languageIds, languageAliases[language] ?? language) : undefined) ?? materialFileIcons.file;
}

/** 静态 SVG 与 renderer 的 HTML 一起提供，路径相对于当前入口。 */
export function materialFileIconUrl(path: string): string {
  return `./file-type-icons/${iconNameForPath(path)}.svg`;
}
