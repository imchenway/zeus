import { useEffect, useRef, useState } from 'react';
import type { ZeusComputerPreview } from '@zeus/shared';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { HandPalmIcon as HandPalm } from '@phosphor-icons/react/dist/csr/HandPalm';
import { PreviewImage } from '../code/FilePreview.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { MotionPresence } from '../ui/MotionPresence.js';

/** 会话环境信息下展示最近一次观察，更新不触发整个会话重新渲染。 */
export function SessionComputerPreview(props: { conversationId: string; language: SessionUiLanguage; active: boolean }) {
  /** 仅保留本会话最新的有界缩略图。 */
  const [preview, setPreview] = useState<ZeusComputerPreview | null>(null);
  /** 完整预览固定用户点击时的画面，后续观察不会替换正在审阅的图片。 */
  const [expanded, setExpanded] = useState<{ url: string; name: string } | null>(null);
  /** 画面解码失败时就地降级，新观察图片到达后自动恢复。 */
  const [failedImage, setFailedImage] = useState<string | null>(null);
  /** 只禁用正在停止的精确控制身份，旧请求不能禁用新会话的停止按钮。 */
  const [stopping, setStopping] = useState<{ conversationId: string; sessionId: string } | null>(null);
  /** 只接受最近一次停止请求的失败说明，避免旧请求覆盖新请求结果。 */
  const stopRequest = useRef<{ conversationId: string; sessionId: string } | null>(null);
  /** 当前画面对应的停止请求是否仍在等待。 */
  const busy = stopping !== null && stopping.conversationId === preview?.conversationId && stopping.sessionId === preview?.sessionId;
  /** 读取失败立即移除旧画面，操作失败就地说明。 */
  const [error, setError] = useState<{ conversationId: string; sessionId: string; message: string } | null>(null);
  /** 连接恢复后自动清除读取错误，不覆盖用户命令的失败说明。 */
  const [readFailed, setReadFailed] = useState(false);
  /** 跟随现有会话语言。 */
  const zh = props.language === 'zh-CN';
  /** 旧会话迟到的命令错误不能出现在新会话。 */
  const errorMessage = error?.conversationId === props.conversationId && (!preview || error.sessionId === preview.sessionId) ? error.message : null;

  useEffect(() => {
    const bridge = window.zeus;
    if (!props.active || !bridge?.getComputerPreview) return;
    // 同一图片只传一次；合并读取期间的通知，隐藏页面恢复可见时再更新。
    let disposed = false;
    let reading = false;
    let dirty = false;
    let cached: ZeusComputerPreview | null = null;
    setPreview(null);
    setReadFailed(false);
    /** 每次读取前重新核对页面可见性，隐藏后不补发图像请求。 */
    const pageVisible = (): boolean => document.visibilityState !== 'hidden';
    /** 请求元数据及真正变化的图片，迟到响应不能覆盖另一会话。 */
    const refresh = async (): Promise<void> => {
      dirty = true;
      if (reading || !pageVisible()) return;
      reading = true;
      try {
        while (dirty && !disposed && pageVisible()) {
          dirty = false;
          const next = await bridge.getComputerPreview(props.conversationId, cached?.imageId);
          if (disposed) break;
          cached = next?.conversationId === props.conversationId ? { ...next, imageUrl: next.imageId && next.imageId === cached?.imageId && next.sessionId === cached.sessionId ? cached.imageUrl : next.imageUrl } : null;
          setPreview(cached);
          setReadFailed(false);
        }
      } catch {
        if (!disposed) {
          cached = null;
          setPreview(null);
          setReadFailed(true);
        }
      } finally {
        reading = false;
      }
    };
    /** 仅刷新本会话，不因其他任务更新重复读图。 */
    const unsubscribe = bridge.onComputerPreviewChanged((conversationId) => {
      if (conversationId === props.conversationId) void refresh();
    });
    /** 可见性恢复补读隐藏期间的最后状态。 */
    const visible = (): void => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    void refresh();
    return () => {
      disposed = true;
      unsubscribe();
      document.removeEventListener('visibilitychange', visible);
    };
  }, [props.active, props.conversationId]);

  /** 使用画面所属的控制身份，迟到的按钮操作不能影响另一轮。 */
  async function stopControl(): Promise<void> {
    if (!preview || !window.zeus) return;
    const identity = { conversationId: preview.conversationId, sessionId: preview.sessionId };
    stopRequest.current = identity;
    setStopping(identity);
    setError(null);
    try {
      await window.zeus.stopComputerUse(identity);
      setPreview((current) => (current?.conversationId === identity.conversationId && current.sessionId === identity.sessionId ? null : current));
    } catch (failure) {
      if (stopRequest.current === identity) setError({ ...identity, message: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      if (stopRequest.current === identity) stopRequest.current = null;
      setStopping((current) => (current?.conversationId === identity.conversationId && current.sessionId === identity.sessionId ? null : current));
    }
  }

  if (!props.active || (!preview && !errorMessage && !readFailed)) return null;
  /** 状态保留在控制详情和读屏说明中，缩略图下方不展开诊断。 */
  const status =
    preview?.state === 'paused'
      ? zh
        ? '已让权给你'
        : 'Paused for you'
      : preview?.state === 'error'
        ? zh
          ? '需要处理'
          : 'Needs attention'
        : preview?.state === 'starting'
          ? zh
            ? '正在启动'
            : 'Starting'
          : preview?.needsObservation
            ? zh
              ? '等待重新观察'
              : 'Waiting for observation'
            : zh
              ? '正在控制'
              : 'Controlling';
  return (
    <section className="session-computer-preview" aria-label={zh ? '屏幕控制' : 'Screen control'}>
      {preview ? (
        <>
          <div className="session-computer-preview-image">
            {preview.imageUrl && failedImage !== preview.imageUrl ? (
              <button
                type="button"
                className="session-computer-preview-open"
                aria-label={zh ? `预览 ${preview.appName} 完整画面` : `Preview full capture of ${preview.appName}`}
                onClick={() => setExpanded({ url: preview.imageUrl!, name: preview.appName })}
              >
                <img src={preview.imageUrl} alt={zh ? `${preview.appName} 上次观察画面` : `Last observed view of ${preview.appName}`} draggable={false} onError={() => setFailedImage(preview.imageUrl)} />
              </button>
            ) : (
              <p role="status">
                {preview.imageUrl && failedImage === preview.imageUrl
                  ? zh
                    ? '画面加载失败，仍可停止控制。'
                    : 'Capture unavailable. You can still stop control.'
                  : zh
                    ? '尚无截图，仍可停止控制。'
                    : 'No capture yet. You can still stop control.'}
              </p>
            )}
            <div className="session-computer-preview-controls">
              <button
                type="button"
                disabled={busy}
                aria-busy={busy || undefined}
                aria-label={zh ? '停止本会话屏幕控制' : 'Stop screen control for this conversation'}
                data-icon-tooltip={zh ? '停止屏幕控制' : 'Stop screen control'}
                onClick={() => void stopControl()}
              >
                <X aria-hidden="true" />
              </button>
              <details className="session-computer-preview-info">
                <summary aria-label={zh ? '屏幕控制详情' : 'Screen control details'} data-icon-tooltip={zh ? '屏幕控制详情' : 'Screen control details'}>
                  <HandPalm aria-hidden="true" />
                </summary>
                <div>
                  <strong>{preview.appName}</strong>
                  <span>{preview.windowTitle || preview.appName}</span>
                  <span>
                    {status} · {preview.action}
                  </span>
                  {preview.capturedAt ? <time dateTime={preview.capturedAt}>{new Date(preview.capturedAt).toLocaleTimeString()}</time> : null}
                  {errorMessage ? <VisibleApplicationError error={errorMessage} language={zh ? 'zh-CN' : 'en'} summary={zh ? '未能停止屏幕控制。' : 'Screen control could not be stopped.'} /> : null}
                  {/* 失败诊断按需打开；用户接管等正常说明保留原意，不误报成错误。 */}
                  {preview.detail ? preview.state === 'error' ? <VisibleApplicationError error={preview.detail} language={zh ? 'zh-CN' : 'en'} summary={zh ? '控制说明' : 'Control information'} /> : <span>{preview.detail}</span> : null}
                </div>
              </details>
            </div>
          </div>
          <p className="visually-hidden" role="status">
            {status}
          </p>
        </>
      ) : null}
      {errorMessage && !preview ? (
        <p role="alert">
          <VisibleApplicationError error={errorMessage} language={zh ? 'zh-CN' : 'en'} summary={zh ? '未能停止屏幕控制。' : 'Screen control could not be stopped.'} />
        </p>
      ) : null}
      {readFailed ? <p role="status">{zh ? '屏幕控制状态暂时不可用。' : 'Screen control status is unavailable.'}</p> : null}
      <MotionPresence>
        {expanded ? (
          <ModalPortal rootClassName="file-preview-portal" role="dialog" aria-label={zh ? '屏幕画面预览' : 'Screen capture preview'} onDismiss={() => setExpanded(null)}>
            <section className="file-preview-dialog" data-modal-surface="dialog">
              <div className="file-preview file-preview-simple-image">
                <header className="file-preview-dialog-header">
                  <strong>{expanded.name}</strong>
                  <button type="button" className="file-preview-close" aria-label={zh ? '关闭' : 'Close'} onClick={() => setExpanded(null)}>
                    <X size={18} aria-hidden="true" />
                  </button>
                </header>
                <PreviewImage url={expanded.url} name={expanded.name} zh={zh} compact />
              </div>
            </section>
          </ModalPortal>
        ) : null}
      </MotionPresence>
    </section>
  );
}
