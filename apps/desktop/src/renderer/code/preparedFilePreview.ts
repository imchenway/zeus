import type { FilePreviewItem, FilePreviewRequest } from '@zeus/shared';
import { detectSourceLanguage } from '@zeus/shared';
import { loadSourceLanguage } from './sourceLanguageRegistry.js';

/** 缓存与可见预览共享同一次授权；最后一个使用者离开才释放令牌。 */
export interface PreparedFilePreview {
  read: Promise<FilePreviewItem[]>;
  items?: FilePreviewItem[];
  /** 缓存中的正文大小，单位为 UTF-16 字节。 */
  byteLength: number;
  retain(): () => void;
  dispose(): void;
}

/** 只通过原预览接口取得文件，不增加磁盘路径或写入权限。 */
export function prepareFilePreview(request: FilePreviewRequest): PreparedFilePreview {
  /** 缓存先持有一份引用，可见预览独立持有其余引用。 */
  let users = 1;
  /** 缓存淘汰只释放一次，未完成读取仍由可见预览持有。 */
  let disposed = false;
  /** 令牌释放与迟到读取共用同一个完成判断。 */
  let released = false;
  /** 没有使用者时归还当前窗口取得的授权令牌。 */
  const release = () => {
    if (users || !entry.items || released) return;
    released = true;
    void window.zeus?.releaseFilePreview(entry.items.map((item) => item.id).filter(Boolean)).catch(() => undefined);
  };
  /** 正文和授权令牌始终属于同一次读取。 */
  const entry: PreparedFilePreview = {
    byteLength: 0,
    read: Promise.resolve()
      .then(() => {
        if (!window.zeus?.loadFilePreview) throw new Error('File preview service is unavailable.');
        return window.zeus.loadFilePreview(request);
      })
      .then(async (items) => {
        // 语言包仍按实际文件加载；失败只保留纯文本，不阻断文件查看。
        await Promise.allSettled(items.filter((item) => item.kind === 'text').map((item) => loadSourceLanguage(detectSourceLanguage(item.path ?? item.label))));
        entry.items = items;
        entry.byteLength = items.reduce((bytes, item) => bytes + (item.content?.length ?? 0) * 2, 0);
        release();
        return items;
      }),
    retain() {
      if (released) throw new Error('File preview has been released.');
      users += 1;
      /** 同一挂载的清理和迟到回执不能重复释放。 */
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        users -= 1;
        release();
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      users -= 1;
      release();
    },
  };
  return entry;
}
