import type { Icon, IconProps } from '@phosphor-icons/react';
import type { ConversationFileIconKind } from '@zeus/shared';
import { FileIcon } from '@phosphor-icons/react/dist/csr/File';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { FileImageIcon } from '@phosphor-icons/react/dist/csr/FileImage';
import { FileTextIcon } from '@phosphor-icons/react/dist/csr/FileText';
import { FilePdfIcon } from '@phosphor-icons/react/dist/csr/FilePdf';
import { FileArchiveIcon } from '@phosphor-icons/react/dist/csr/FileArchive';
import { FileAudioIcon } from '@phosphor-icons/react/dist/csr/FileAudio';
import { FileVideoIcon } from '@phosphor-icons/react/dist/csr/FileVideo';
import { FileTsIcon } from '@phosphor-icons/react/dist/csr/FileTs';
import { FileJsIcon } from '@phosphor-icons/react/dist/csr/FileJs';
import { FileJsxIcon } from '@phosphor-icons/react/dist/csr/FileJsx';
import { FileHtmlIcon } from '@phosphor-icons/react/dist/csr/FileHtml';
import { FileCssIcon } from '@phosphor-icons/react/dist/csr/FileCss';
import { FileMdIcon } from '@phosphor-icons/react/dist/csr/FileMd';
import { FileSqlIcon } from '@phosphor-icons/react/dist/csr/FileSql';
import { FileDocIcon } from '@phosphor-icons/react/dist/csr/FileDoc';
import { FileXlsIcon } from '@phosphor-icons/react/dist/csr/FileXls';
import { FilePptIcon } from '@phosphor-icons/react/dist/csr/FilePpt';
import { FileCsvIcon } from '@phosphor-icons/react/dist/csr/FileCsv';
import { FileCIcon } from '@phosphor-icons/react/dist/csr/FileC';
import { FileCppIcon } from '@phosphor-icons/react/dist/csr/FileCpp';
import { FilePyIcon } from '@phosphor-icons/react/dist/csr/FilePy';
import { FileVueIcon } from '@phosphor-icons/react/dist/csr/FileVue';
import { BracketsCurlyIcon } from '@phosphor-icons/react/dist/csr/BracketsCurly';
import './fileAppearance.css';

/** 资源保留既有类型语义，文件树额外区分库内已有的媒体和语言图标。 */
export type FileIconKind = ConversationFileIconKind | 'text' | 'audio' | 'video' | 'jsx' | 'csv' | 'c' | 'cpp' | 'python' | 'vue';

/** 会话资源、源码树和交付树共用同一套 Phosphor 文件图标。 */
const fileIcons: Record<FileIconKind, Icon> = {
  // 语言类型保留文件轮廓，JSON 使用库内对应的大括号图形。
  typescript: FileTsIcon,
  javascript: FileJsIcon,
  jsx: FileJsxIcon,
  html: FileHtmlIcon,
  css: FileCssIcon,
  markdown: FileMdIcon,
  sql: FileSqlIcon,
  c: FileCIcon,
  cpp: FileCppIcon,
  python: FilePyIcon,
  vue: FileVueIcon,
  json: BracketsCurlyIcon,
  java: FileCodeIcon,
  code: FileCodeIcon,
  // 文档、媒体和未知类型都来自图标库，不保留自绘类型字标。
  image: FileImageIcon,
  pdf: FilePdfIcon,
  spreadsheet: FileXlsIcon,
  presentation: FilePptIcon,
  document: FileDocIcon,
  archive: FileArchiveIcon,
  audio: FileAudioIcon,
  video: FileVideoIcon,
  csv: FileCsvIcon,
  text: FileTextIcon,
  file: FileIcon,
};

/** 类型识别只影响图形，完整路径、打开目标和读取权限不受影响。 */
const fileKindPatterns: readonly (readonly [RegExp, FileIconKind])[] = [
  [/\.(ts|tsx|mts|cts)$/iu, 'typescript'],
  [/\.jsx$/iu, 'jsx'],
  [/\.(js|mjs|cjs)$/iu, 'javascript'],
  [/\.vue$/iu, 'vue'],
  [/\.(html?|xhtml)$/iu, 'html'],
  [/\.(css|s[ac]ss|less|wxss)$/iu, 'css'],
  [/\.(md|mdx|markdown)$/iu, 'markdown'],
  [/\.(json|jsonc|json5)$/iu, 'json'],
  [/\.sql$/iu, 'sql'],
  [/\.(c|h)$/iu, 'c'],
  [/\.(cpp|cc|cxx|hpp|hxx)$/iu, 'cpp'],
  [/\.(py|pyi|pyw)$/iu, 'python'],
  [/\.java$/iu, 'java'],
  [/\.(png|jpe?g|gif|webp|avif|bmp|ico|icns|svg|tiff?|heic)$/iu, 'image'],
  [/\.pdf$/iu, 'pdf'],
  [/\.(zip|gz|tgz|7z|rar|tar|bz2|xz)$/iu, 'archive'],
  [/\.(mp3|wav|ogg|flac|m4a|aac|aiff?)$/iu, 'audio'],
  [/\.(mp4|webm|mov|ogv|mkv|avi)$/iu, 'video'],
  [/\.(xlsx?|ods|numbers)$/iu, 'spreadsheet'],
  [/\.(pptx?|odp|key)$/iu, 'presentation'],
  [/\.(docx?|odt|rtf|pages)$/iu, 'document'],
  [/\.(csv|tsv)$/iu, 'csv'],
  [/\.(txt|log)$/iu, 'text'],
  [/\.(ya?ml|toml|xml|wxml|svelte|go|rs|kt|swift|cs|php|rb|sh|bash|zsh|fish|plist|ini|conf|config)$/iu, 'code'],
];

/** 资源已经提供结构化类型时直接取图标，未知值仍使用库内普通文件。 */
export function fileIconForKind(kind: FileIconKind): Icon {
  return fileIcons[kind] ?? FileIcon;
}

/** 按文件名识别展示类型，未覆盖的扩展名统一使用普通文件图标。 */
export function fileIconKindForName(name: string): FileIconKind {
  return fileKindPatterns.find(([pattern]) => pattern.test(name))?.[1] ?? 'file';
}

/** 文件入口共用 Phosphor 图标；类型只影响外观，不决定内容解码或读取权限。 */
export function FileTypeIcon({ name, className, ...props }: IconProps & { name: string }) {
  /** 按原文件扩展名选择图标，未知类型保留普通文件图标。 */
  const kind = fileIconKindForName(name);
  /** 直接使用已有组件，不维护另一套 SVG 或图标注册器。 */
  const Icon = fileIconForKind(kind);
  return <Icon size={16} weight="regular" aria-hidden="true" {...props} className={`file-type-icon${className ? ` ${className}` : ''}`} data-file-kind={kind} />;
}
