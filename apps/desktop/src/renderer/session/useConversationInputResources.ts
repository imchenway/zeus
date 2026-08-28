import { type ClipboardEvent, type DragEvent, type KeyboardEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { NativeConversationAttachment } from './sessionTypes.js';
import { PENDING_RESOURCE_LONG_TEXT_THRESHOLD } from '../ui/pendingResourcePolicy.js';

export const CONVERSATION_LONG_PASTE_THRESHOLD = PENDING_RESOURCE_LONG_TEXT_THRESHOLD;

interface UseConversationInputResourcesOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  disabled: boolean;
  onTextChange: (text: string) => void;
  onAddAttachments: (attachments: NativeConversationAttachment[]) => void;
  onRemoveAttachment: (attachment: NativeConversationAttachment) => void;
  onError: (message: string) => void;
}

export interface ConversationInputResourceHandlers {
  processing: boolean;
  dragging: boolean;
  handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void;
  handlePasteShortcut(event: KeyboardEvent<HTMLTextAreaElement>): void;
  handleDragEnter(event: DragEvent<HTMLElement>): void;
  handleDragOver(event: DragEvent<HTMLElement>): void;
  handleDragLeave(event: DragEvent<HTMLElement>): void;
  handleDrop(event: DragEvent<HTMLElement>): void;
  restorePastedText(attachment: NativeConversationAttachment): void;
}

export function useConversationInputResources(options: UseConversationInputResourcesOptions): ConversationInputResourceHandlers {
  const [processingCount, setProcessingCount] = useState(0);
  const [dragDepth, setDragDepth] = useState(0);
  const pasteGeneration = useRef(0);
  const mounted = useRef(true);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pasteGeneration.current += 1;
    };
  }, []);

  const runResourceOperation = useCallback(async (operation: () => Promise<void>) => {
    if (latest.current.disabled) return;
    setProcessingCount((current) => current + 1);
    try {
      await operation();
    } catch (error) {
      latest.current.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setProcessingCount((current) => Math.max(0, current - 1));
    }
  }, []);

  const addFiles = useCallback(
    (files: File[], source: 'paste' | 'drop') => {
      if (files.length === 0) return;
      void runResourceOperation(async () => {
        const bridge = window.zeus?.authorizeConversationFiles;
        if (!bridge) throw new Error('当前应用版本未提供会话附件导入能力。');
        const result = await bridge(files, source);
        if (result.resources.length === 0) throw new Error('没有可读取的文件或文件夹。');
        latest.current.onAddAttachments(result.resources);
        if (result.failedCount > 0) {
          latest.current.onError(`已添加可读取资源，另有 ${result.failedCount} 项读取失败。`);
        }
      });
    },
    [runResourceOperation],
  );

  const materializeLongText = useCallback(
    (text: string, selection: TextSelection) => {
      void runResourceOperation(async () => {
        const bridge = window.zeus?.materializeConversationResources;
        if (!bridge) {
          insertText(latest.current, text, selection);
          throw new Error('当前应用版本未提供长文本转附件能力。');
        }
        try {
          const attachments = await bridge([{ name: 'Pasted text.txt', type: 'text/plain', text, source: 'paste', kind: 'pasted_text' }]);
          if (attachments.length === 0) throw new Error('长文本附件未能保存。');
          latest.current.onAddAttachments(attachments);
        } catch (error) {
          insertText(latest.current, text, selection);
          throw error;
        }
      });
    },
    [runResourceOperation],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      pasteGeneration.current += 1;
      if (latest.current.disabled) return;
      const files = dataTransferFiles(event.clipboardData);
      if (files.length > 0) {
        event.preventDefault();
        addFiles(files, 'paste');
        return;
      }
      const text = safelyReadData(event.clipboardData, 'text/plain');
      if (text.length < CONVERSATION_LONG_PASTE_THRESHOLD) return;
      event.preventDefault();
      materializeLongText(text, currentSelection(event.currentTarget));
    },
    [addFiles, materializeLongText],
  );

  const handlePasteShortcut = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (latest.current.disabled || event.key.toLocaleLowerCase() !== 'v' || (!event.metaKey && !event.ctrlKey) || event.altKey) return;
      const generation = ++pasteGeneration.current;
      const selection = currentSelection(event.currentTarget);
      globalThis.setTimeout(() => {
        if (!mounted.current || generation !== pasteGeneration.current || latest.current.disabled) return;
        void runResourceOperation(async () => {
          const bridge = window.zeus?.readConversationClipboardResources;
          if (!bridge) throw new Error('当前应用版本未提供原生剪贴板附件读取能力。');
          const result = await bridge();
          if (generation !== pasteGeneration.current) return;
          if (result.resources.length > 0) {
            latest.current.onAddAttachments(result.resources);
            return;
          }
          if (result.text) insertText(latest.current, result.text, selection);
        });
      }, 120);
    },
    [runResourceOperation],
  );

  const handleDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    if (latest.current.disabled || !hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    setDragDepth((current) => current + 1);
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (latest.current.disabled || !hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    setDragDepth((current) => Math.max(0, current - 1));
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      if (latest.current.disabled || !hasFiles(event.dataTransfer)) return;
      event.preventDefault();
      setDragDepth(0);
      addFiles(dataTransferFiles(event.dataTransfer), 'drop');
    },
    [addFiles],
  );

  const restorePastedText = useCallback((attachment: NativeConversationAttachment) => {
    if (!attachment.restorableText || latest.current.disabled) return;
    const textarea = latest.current.textareaRef.current;
    insertText(latest.current, attachment.restorableText, textarea ? currentSelection(textarea) : { start: latest.current.text.length, end: latest.current.text.length });
    latest.current.onRemoveAttachment(attachment);
  }, []);

  return {
    processing: processingCount > 0,
    dragging: dragDepth > 0,
    handlePaste,
    handlePasteShortcut,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    restorePastedText,
  };
}

interface TextSelection {
  start: number;
  end: number;
}

function currentSelection(textarea: HTMLTextAreaElement): TextSelection {
  return {
    start: textarea.selectionStart ?? textarea.value.length,
    end: textarea.selectionEnd ?? textarea.value.length,
  };
}

function insertText(options: UseConversationInputResourcesOptions, inserted: string, selection: TextSelection): void {
  const start = Math.min(selection.start, options.text.length);
  const end = Math.min(Math.max(start, selection.end), options.text.length);
  const next = `${options.text.slice(0, start)}${inserted}${options.text.slice(end)}`;
  options.onTextChange(next);
  globalThis.requestAnimationFrame(() => {
    const textarea = options.textareaRef.current;
    if (!textarea) return;
    const caret = start + inserted.length;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  });
}

function dataTransferFiles(dataTransfer: DataTransfer): File[] {
  const files = Array.from(dataTransfer.files);
  if (files.length > 0) return files;
  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

function hasFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes('Files') || dataTransfer.files.length > 0;
}

function safelyReadData(dataTransfer: DataTransfer, type: string): string {
  try {
    return dataTransfer.getData(type);
  } catch {
    return '';
  }
}
