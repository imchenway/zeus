import { useEffect, useState } from 'react';
import { CursorIcon } from '@phosphor-icons/react/dist/csr/Cursor';
import type { ZeusComputerPreview } from '@zeus/shared';
import type { SessionUiLanguage } from './ThreadItemView.js';

/** 会话环境信息下的实时控制画面，更新不触发整个会话重新渲染。 */
export function SessionComputerPreview(props: { conversationId: string; language: SessionUiLanguage; active: boolean }) {
  /** 仅保留本会话最新的有界缩略图。 */
  const [preview, setPreview] = useState<ZeusComputerPreview | null>(null);
  /** 用户命令执行期间防止重复点击。 */
  const [busy, setBusy] = useState(false);
  /** 读取失败立即移除旧画面，操作失败就地说明。 */
  const [error, setError] = useState<string | null>(null);
  /** 连接恢复后自动清除读取错误，不覆盖用户命令的失败说明。 */
  const [readFailed, setReadFailed] = useState(false);
  /** 跟随现有会话语言。 */
  const zh = props.language === 'zh-CN';

  useEffect(() => {
    const bridge = window.zeus;
    if (!props.active || !bridge?.getComputerPreview) return;
    // 完成上次读取后才安排下一次，隐藏页面不读取；切换会话时丢弃迟到结果。
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      try {
        if (document.visibilityState !== 'hidden') {
          const next = await bridge.getComputerPreview(props.conversationId);
          if (!disposed) {
            setPreview(next?.conversationId === props.conversationId ? next : null);
            setReadFailed(false);
          }
        }
      } catch {
        if (!disposed) {
          setPreview(null);
          setReadFailed(true);
        }
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 500);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [props.active, props.conversationId, zh]);

  /** 使用画面所属的控制身份，迟到的按钮操作不能影响另一轮。 */
  async function control(action: 'stop' | 'resume'): Promise<void> {
    if (!preview || !window.zeus) return;
    const identity = { conversationId: preview.conversationId, sessionId: preview.sessionId };
    setBusy(true);
    setError(null);
    try {
      if (action === 'stop') {
        await window.zeus.stopComputerUse(identity);
        setPreview(null);
      } else {
        await window.zeus.resumeComputerUse(identity);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  if (!props.active || (!preview && !error && !readFailed)) return null;
  return (
    <section className="session-computer-preview" aria-label={zh ? '屏幕控制' : 'Screen control'}>
      {preview ? (
        <>
          <header>
            <span>
              <strong>{preview.appName}</strong>
              <small role="status">
                {preview.paused
                  ? zh
                    ? '等待用户操作结束 · 空闲 3 秒后自动继续'
                    : 'Waiting for user · continues after 3 seconds idle'
                  : preview.needsObservation
                    ? zh
                      ? '等待重新观察'
                      : 'Waiting for observation'
                    : zh
                      ? '正在控制'
                      : 'Controlling'}
              </small>
            </span>
            <div>
              {preview.paused ? (
                <button type="button" disabled={busy} onClick={() => void control('resume')}>
                  {zh ? '立即继续' : 'Resume now'}
                </button>
              ) : null}
              <button type="button" disabled={busy} aria-label={zh ? '停止本会话屏幕控制' : 'Stop screen control for this conversation'} onClick={() => void control('stop')}>
                {zh ? '停止' : 'Stop'}
              </button>
            </div>
          </header>
          <div className="session-computer-preview-image">
            {preview.imageUrl ? <img src={preview.imageUrl} alt={zh ? `${preview.appName} 实时画面` : `Live view of ${preview.appName}`} draggable={false} /> : <p>{zh ? '正在获取画面…' : 'Waiting for image…'}</p>}
            {preview.imageUrl && preview.cursor && !preview.paused && !preview.needsObservation ? (
              <CursorIcon className="session-computer-preview-cursor" weight="fill" aria-hidden="true" style={{ left: `${preview.cursor.x * 100}%`, top: `${preview.cursor.y * 100}%` }} />
            ) : null}
          </div>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {readFailed ? <p role="status">{zh ? '屏幕控制状态暂时不可用。' : 'Screen control status is unavailable.'}</p> : null}
    </section>
  );
}
