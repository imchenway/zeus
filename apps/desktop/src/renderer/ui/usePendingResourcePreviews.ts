import { useCallback, useEffect, useRef, useState } from 'react';
import type { PendingResourceCardItem } from './PendingResourceCards.js';
import { PENDING_RESOURCE_LONG_TEXT_THRESHOLD } from './pendingResourcePolicy.js';

/** 三类附件输入共用即时卡片与 Blob 生命周期，临时引用始终只存在于界面。 */
export function usePendingResourcePreviews(resources: readonly PendingResourceCardItem[], language: 'zh-CN' | 'en-US', contextKey: string | false = 'input') {
  /** 导入中的卡片与已确认图片的本地缩略图。 */
  const [pendingResources, setPendingResources] = useState<PendingResourceCardItem[]>([]);
  /** 对象 URL 的当前归属，可从临时身份接续到真实资源身份。 */
  const previewUrls = useRef(new Map<string, string>());
  /** 异步回执只允许操作仍然存在的输入场景。 */
  const mounted = useRef(true);
  /** 同步记录当前场景，切换任务或关闭弹窗后旧回执立即失效。 */
  const context = useRef(contextKey);
  /** 同一弹窗关闭再打开也使旧操作失效，不能只比较相同场景名称。 */
  const generation = useRef(0);
  /** 对比场景变化后统一释放旧预览。 */
  const previousContext = useRef(contextKey);
  if (context.current !== contextKey) generation.current += 1;
  context.current = contextKey;

  useEffect(() => {
    mounted.current = true;
    /** 捕获本组件的资源表，卸载时不依赖新的引用。 */
    const urls = previewUrls.current;
    return () => {
      mounted.current = false;
      for (const url of urls.keys()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  useEffect(() => {
    if (previousContext.current === contextKey) return;
    previousContext.current = contextKey;
    for (const url of previewUrls.current.keys()) URL.revokeObjectURL(url);
    previewUrls.current.clear();
    setPendingResources([]);
  }, [contextKey]);

  useEffect(() => {
    if (pendingResources.length === 0) return;
    /** 按真实资源身份筛选，删除附件后立即释放本地预览。 */
    const ids = new Set(resources.map((resource) => resource.id));
    /** 导入中的卡片保留到各自完成，成功缩略图保留到草稿移除。 */
    const retained = pendingResources.filter((resource) => resource.pending || ids.has(resource.id));
    if (retained.length === pendingResources.length) return;
    for (const resource of pendingResources) {
      if (resource.pending || ids.has(resource.id) || !resource.previewUrl) continue;
      URL.revokeObjectURL(resource.previewUrl);
      previewUrls.current.delete(resource.previewUrl);
    }
    /** 清理只针对本轮看到的旧卡片，不能覆盖期间新建的导入反馈。 */
    const removedIds = new Set(pendingResources.filter((resource) => !resource.pending && !ids.has(resource.id)).map((resource) => resource.id));
    setPendingResources((current) => current.filter((resource) => !removedIds.has(resource.id)));
  }, [resources, pendingResources]);

  /** 创建独立的一批预览；调用者继续负责授权、保存、失败提示与提交校验。 */
  const begin = useCallback(
    (files: readonly File[] = [], text = '', scope?: string) => {
      /** 固定当前场景，防止任务切换后把旧结果带入新表单。 */
      const operationContext = context.current;
      /** 记录当前输入生命周期，回执不能跨场景重新生效。 */
      const operationGeneration = generation.current;
      /** 对未保存资源只分配界面身份，不能用作可发送附件引用。 */
      const pending: PendingResourceCardItem[] =
        files.length > 0
          ? files.map((file) => {
              /** 浏览器直接显示已有 Blob，不额外读取和序列化完整图片。 */
              const previewUrl = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type) ? URL.createObjectURL(file) : undefined;
              /** 每次导入独立定位，连续粘贴不覆盖之前的反馈。 */
              const id = crypto.randomUUID();
              if (previewUrl) previewUrls.current.set(previewUrl, id);
              return { id, name: file.name, kind: file.type.startsWith('image/') ? 'image' : 'file', mimeType: file.type, size: file.size, previewUrl, pending: true, scope };
            })
          : [
              {
                id: crypto.randomUUID(),
                name: text.length >= PENDING_RESOURCE_LONG_TEXT_THRESHOLD ? 'Pasted text.txt' : language === 'zh-CN' ? '剪贴板内容' : 'Clipboard content',
                kind: text.length >= PENDING_RESOURCE_LONG_TEXT_THRESHOLD ? 'pasted_text' : 'file',
                characterCount: text.length || undefined,
                pending: true,
                scope,
              },
            ];
      setPendingResources((current) => [...current, ...pending]);

      /** 授权回执、字段回填和错误提示都须确认原输入场景仍然有效。 */
      const current = () => mounted.current && operationContext !== false && generation.current === operationGeneration && context.current === operationContext;
      return {
        current,
        /** 成功图片沿用同一 Blob；同名或部分失败时继续由宿主读取受信预览。 */
        complete(confirmed: readonly PendingResourceCardItem[], failedCount = 0): void {
          if (!current() || failedCount > 0) return;
          for (const resource of confirmed) {
            /** 只接续能唯一匹配的图片，避免把不同文件的缩略图混用。 */
            const matching = pending.filter((preview) => preview.name === resource.name && preview.previewUrl);
            if (resource.kind !== 'image' || matching.length !== 1 || [...previewUrls.current.values()].includes(resource.id)) continue;
            /** 本地预览改为真实身份，但不进入资源持久化载荷。 */
            const preview = matching[0]!;
            previewUrls.current.set(preview.previewUrl!, resource.id);
            setPendingResources((values) => [...values.filter((value) => value.id !== preview.id), { ...preview, id: resource.id, pending: false }]);
          }
        },
        /** 仅清理本次操作，成功接续的图片继续保留，其余 Blob 立即释放。 */
        finish(): void {
          if (current()) {
            /** 不影响其他仍在导入的附件。 */
            const ids = new Set(pending.map((resource) => resource.id));
            setPendingResources((values) => values.filter((resource) => !ids.has(resource.id)));
          }
          for (const resource of pending) {
            if (!resource.previewUrl || previewUrls.current.get(resource.previewUrl) !== resource.id) continue;
            URL.revokeObjectURL(resource.previewUrl);
            previewUrls.current.delete(resource.previewUrl);
          }
        },
      };
    },
    [language],
  );

  return { pendingResources, begin };
}

/** 各附件列表共用相同接续方式，真实卡片使用本地预览，未确认卡片只追加显示。 */
export function mergePendingResourcePreviews(resources: PendingResourceCardItem[], previews: readonly PendingResourceCardItem[] = []): PendingResourceCardItem[] {
  /** 用真实身份匹配缩略图，保留调用者已有的预览。 */
  const byId = new Map(previews.map((resource) => [resource.id, resource.previewUrl]));
  return [...resources.map((resource) => ({ ...resource, previewUrl: byId.get(resource.id) ?? resource.previewUrl })), ...previews.filter((resource) => resource.pending)];
}

/** files 与 items 是同一批附件的两种视图；优先读取 files，仅在为空时从 items 回退。 */
export function dataTransferFiles(dataTransfer: DataTransfer): File[] {
  /** 保留真实批次中的每个文件，不按名称或时间误合并不同附件。 */
  const files = Array.from(dataTransfer.files);
  if (files.length > 0) return files;
  return Array.from(dataTransfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

/** 普通文本不读取系统剪贴板；文件引用或浏览器未给出 File 的原生格式才需要回退。 */
export function clipboardNeedsResourceRead(data: DataTransfer, text: string): boolean {
  if (data.types.includes('Files') || data.types.includes('text/uri-list') || /^(?:file:\/\/|\/|[a-z]:[\\/])/imu.test(text)) return true;
  try {
    return /(?:href|src)=["']file:\/\//iu.test(data.getData('text/html'));
  } catch {
    return false;
  }
}

/** 只移除整行且已被授权附件消费的路径，其他说明文字完整保留。 */
export function clipboardTextAfterResources(text: string, resources: readonly { path: string }[]): string {
  /** 页面仅匹配授权回执，不从正文中推测或提取新的路径。 */
  const paths = new Set(resources.map((resource) => resource.path));
  return text
    .split(/\r?\n/u)
    .filter((line) => {
      /** 文件 URL 只用于比较已知路径，不参与文件授权。 */
      let path = line.trim();
      if (path.startsWith('file://')) {
        try {
          path = decodeURIComponent(new URL(path).pathname);
        } catch {
          return true;
        }
      }
      return !paths.has(path);
    })
    .join('\n');
}
