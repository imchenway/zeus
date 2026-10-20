import { useEffect, useState } from 'react';
import type { GitFileBlame } from '../features/git/gitContracts.js';
import { readCachedGitBlame } from './gitBlameCache.js';

/** 项目文件与会话资源分别使用已有的读取权限。 */
export interface UseGitBlameOptions {
  /** 预览版本使用窗口私有令牌，不回退到项目工作区。 */
  previewId?: string;
  projectId?: string;
  filePath?: string;
  ref?: string;
  /** 磁盘内容变更后使用新缓存，避免保存后复用旧行号。 */
  revision?: string;
  /** 会话源码只能用资源身份解析，不回退项目主目录。 */
  conversationId?: string;
  resourceId?: string;
  content?: string;
}

/** 按项目、文件和版本共享短期读取结果，避免滚动或重新渲染重复启动 Git。 */
export function useGitBlame(options: UseGitBlameOptions): GitFileBlame | null {
  /** 项目身份只用于已有权限校验。 */
  const projectId = options.projectId?.trim() ?? '';
  // 文件名两端的空格是合法路径内容，校验时只用 trim，不改变实际 IPC 参数。
  const filePath = options.filePath ?? '';
  /** 历史文件继续按明确引用读取，不改变路径。 */
  const ref = options.ref?.trim() || undefined;
  /** 资源内容参与版本核对，项目文件使用磁盘摘要。 */
  const { conversationId, resourceId, content, revision } = options;
  /** 令牌与旧的项目、会话读取身份互斥。 */
  const previewId = options.previewId;
  /** 会话资源不能回退到项目文件读取。 */
  const resource = Boolean(conversationId || resourceId);
  /** 缓存身份区分项目文件与会话资源。 */
  const cacheKey = previewId ? JSON.stringify(['preview', previewId]) : projectId ? JSON.stringify(resource ? ['resource', projectId, conversationId, resourceId] : ['project', projectId, filePath, ref]) : '';
  /** 桌面能力不可用时保留纯源码显示。 */
  const available = Boolean(
    typeof window !== 'undefined' &&
    (previewId ? window.zeus?.loadFilePreviewBlame : projectId && (resource ? conversationId && resourceId && content !== undefined && window.zeus?.loadConversationSourceBlame : filePath.trim() && window.zeus?.loadProjectSourceBlame)),
  );
  /** 只保存与当前身份和内容匹配的读取结果。 */
  const [blame, setBlame] = useState<{ key: string; revision?: string; content?: string; value: GitFileBlame } | null>(null);

  useEffect(() => {
    /** 文件切换或卸载后忽略旧请求。 */
    let active = true;
    if (!available || !cacheKey) {
      return () => {
        active = false;
      };
    }
    setBlame(null);
    /** 使用真实内容摘要读取，避免旧行号覆盖新内容。 */
    const load = async () => {
      /** 资源摘要与服务端校验一致，不借用项目主目录。 */
      const expectedSha256 = content === undefined ? revision : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))), (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (!active) return null;
      return readCachedGitBlame(cacheKey, expectedSha256 ?? '', () =>
        previewId
          ? window.zeus!.loadFilePreviewBlame(previewId).then((value) => value ?? { path: '', lines: [] })
          : resource
            ? window.zeus!.loadConversationSourceBlame({ projectId, conversationId: conversationId!, resourceId: resourceId!, expectedSha256: expectedSha256! })
            : window.zeus!.loadProjectSourceBlame({ projectId, relativePath: filePath, ...(ref ? { ref } : {}), ...(expectedSha256 ? { expectedSha256 } : {}) }),
      );
    };
    void load()
      .then((value) => {
        if (active && value) setBlame({ key: cacheKey, revision, content, value });
      })
      .catch(() => {
        // 归属读取失败只移除注释，源码阅读与编辑继续可用。
        if (active) setBlame(null);
      });
    return () => {
      active = false;
    };
  }, [available, cacheKey, filePath, projectId, ref, resource, conversationId, resourceId, content, revision, previewId]);

  return available && blame?.key === cacheKey && blame.revision === revision && blame.content === content ? blame.value : null;
}
