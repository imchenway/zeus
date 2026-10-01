import type { IconProps } from '@phosphor-icons/react';
import { FileIcon } from '@phosphor-icons/react/dist/csr/File';
import { FileCodeIcon } from '@phosphor-icons/react/dist/csr/FileCode';
import { FileImageIcon } from '@phosphor-icons/react/dist/csr/FileImage';
import { FileTextIcon } from '@phosphor-icons/react/dist/csr/FileText';
import { FilePdfIcon } from '@phosphor-icons/react/dist/csr/FilePdf';
import { FileZipIcon } from '@phosphor-icons/react/dist/csr/FileZip';
import { FileAudioIcon } from '@phosphor-icons/react/dist/csr/FileAudio';
import { FileVideoIcon } from '@phosphor-icons/react/dist/csr/FileVideo';
import './fileAppearance.css';

/** 文件入口共用 Phosphor 图标；类型只影响外观，不决定内容解码或读取权限。 */
export function FileTypeIcon({ name, className, ...props }: IconProps & { name: string }) {
  /** 按原文件扩展名选择图标，未知类型保留普通文件图标。 */
  const kind = /\.(png|jpe?g|gif|webp|avif|bmp|ico|icns|svg)$/iu.test(name)
    ? 'image'
    : /\.(pdf)$/iu.test(name)
      ? 'pdf'
      : /\.(zip|gz|tgz|7z|rar|tar)$/iu.test(name)
        ? 'archive'
        : /\.(mp3|wav|ogg|flac|m4a|aac)$/iu.test(name)
          ? 'audio'
          : /\.(mp4|webm|mov|ogv)$/iu.test(name)
            ? 'video'
            : /\.(md|markdown|txt|log|csv)$/iu.test(name)
              ? 'text'
              : /\.(tsx?|jsx?|m?[cj]s|json|ya?ml|toml|xml|html?|css|s[ac]ss|less|py|go|rs|java|kt|swift|c|cpp|h|hpp|sh|sql|vue|svelte|plist)$/iu.test(name)
                ? 'code'
                : 'file';
  /** 直接使用已有组件，不维护另一套 SVG 或图标注册器。 */
  const Icon =
    kind === 'image'
      ? FileImageIcon
      : kind === 'pdf'
        ? FilePdfIcon
        : kind === 'archive'
          ? FileZipIcon
          : kind === 'audio'
            ? FileAudioIcon
            : kind === 'video'
              ? FileVideoIcon
              : kind === 'text'
                ? FileTextIcon
                : kind === 'code'
                  ? FileCodeIcon
                  : FileIcon;
  return <Icon size={16} weight="duotone" aria-hidden="true" {...props} className={`file-type-icon${className ? ` ${className}` : ''}`} data-file-kind={kind} />;
}
