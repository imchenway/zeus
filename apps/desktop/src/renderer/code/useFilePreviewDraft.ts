import { useCallback, useEffect, useRef, useState } from 'react';
import type { FilePreviewItem } from '@zeus/shared';

/** 草稿只记录正文和磁盘基线，重新打开时必须重新取得文件授权。 */
interface PreviewDraft {
  /** 首次编辑时的完整正文，用于识别外部修改。 */
  base: string;
  /** 当前未保存正文，保留文件结尾换行。 */
  content: string;
}
/** 会话内保留尚未落盘的草稿，切换文件或关闭面板不丢失输入。 */
const drafts = new Map<string, PreviewDraft>();

/** CodeMirror 使用 LF；保存服务恢复文件原有 BOM 和换行类型。 */
export function previewText(item: FilePreviewItem | undefined): string {
  return (item?.content ?? '').replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
}

/** 所有当前工作区 Diff 共用草稿、保存、版本冲突及持久化生命周期。 */
export function useFilePreviewDraft(identity: string, items: FilePreviewItem[] | null, accept: (items: FilePreviewItem[]) => void) {
  /** 不保存令牌或任意目标路径，草稿按已有业务请求隔离。 */
  const key = `zeus.file-preview.draft:${identity}`;
  /** 首次读取优先保留本窗口最新草稿。 */
  const [draft, setDraft] = useState<PreviewDraft | null>(() => {
    if (drafts.has(key)) return drafts.get(key)!;
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? 'null') as PreviewDraft | null;
      return value && typeof value.base === 'string' && typeof value.content === 'string' ? value : null;
    } catch {
      return null;
    }
  });
  /** 同步引用避免连续按保存键或切换文件时读取旧草稿。 */
  const latest = useRef(draft);
  latest.current = draft;
  /** 在途命令只提交一次，失败后保留正文。 */
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  /** 文件错误与本地暂存错误分别展示，成功暂存不掩盖保存失败。 */
  const [error, setError] = useState<unknown>(null);
  const [storageError, setStorageError] = useState<unknown>(null);
  /** 磁盘正文只来自当前预览的右侧授权版本。 */
  const base = previewText(items?.[1]);
  const dirty = Boolean(draft && draft.content !== base);
  const conflict = Boolean(dirty && draft?.base !== base);
  const writable = Boolean(items?.[1]?.canEditInline && window.zeus?.saveFilePreview);

  /** 每次输入先保留内存草稿，再持久化；返回此文件时仍需重新核对基线。 */
  const update = useCallback(
    (value: PreviewDraft | null) => {
      latest.current = value;
      setDraft(value);
      if (value) drafts.set(key, value);
      else drafts.delete(key);
      try {
        if (value) localStorage.setItem(key, JSON.stringify(value));
        else localStorage.removeItem(key);
        setStorageError(null);
      } catch {
        setStorageError(new Error('草稿暂存失败，请保存文件后再关闭窗口。'));
      }
    },
    [key],
  );
  useEffect(() => {
    /** 已保存或其他入口写入同样内容时清理持久草稿。 */
    if (items?.[1] && latest.current?.content === base) update(null);
  }, [items, base, update]);
  useEffect(() => {
    /** 暂存失败时让浏览器关闭保护保留尚在内存中的正文。 */
    if (!storageError || !dirty) return;
    const preventClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventClose);
    return () => window.removeEventListener('beforeunload', preventClose);
  }, [storageError, dirty]);

  /** 保存中的继续输入独立保留，回执只推进实际提交正文的基线。 */
  async function save(): Promise<void> {
    if (!writable || savingRef.current || !dirty || conflict || !items?.[1]) return;
    const content = latest.current!.content;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await window.zeus!.saveFilePreview({ id: items[1].id, content });
      /** 主进程可能在写入后遇到重读失败，必须保留草稿而非误报成功。 */
      if (result[1]?.kind !== 'text' || result[1].truncated || previewText(result[1]) !== content) {
        void window.zeus?.releaseFilePreview(result.map((item) => item.id).filter(Boolean)).catch(() => undefined);
        throw new Error('保存后的文件尚未核实，请刷新差异；草稿已保留。');
      }
      const current = drafts.get(key);
      update(current?.content === content ? null : { base: content, content: current?.content ?? content });
      accept(result);
    } catch (cause) {
      setError(cause);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  return {
    content: draft?.content ?? base,
    base,
    dirty,
    conflict,
    saving,
    writable,
    error: error ?? storageError,
    /** 所有修改只更新草稿，文件写入由显式保存触发。 */
    onChange(content: string) {
      update(content === base ? null : { base: latest.current?.base ?? base, content });
    },
    onSave: save,
    /** 放弃操作只删除本地草稿，不修改磁盘文件。 */
    onDiscard() {
      update(null);
      setError(null);
    },
  };
}
