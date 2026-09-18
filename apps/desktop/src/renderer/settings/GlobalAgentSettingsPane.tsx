import { lazy, Suspense, useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import type { GlobalAgentSettingsSnapshot } from '@zeus/shared';
import type { SettingsApiClient } from '../features/settings/settingsApiClient.js';
import { Button } from '../ui/Button.js';

const CodeEditor = lazy(() => import('../code/CodeEditor.js').then((module) => ({ default: module.CodeEditor })));

/** 工作区离开确认调用当前编辑器的保存或放弃。 */
export interface GlobalAgentSettingsHandle {
  /** 只有保存成功才允许离开。 */
  save(): Promise<boolean>;
  /** 放弃草稿，不写入磁盘。 */
  discard(): void;
}

/** 全局规则复用代码编辑器，正文仅在点击保存时提交。 */
export function GlobalAgentSettingsPane(props: {
  /** 工作区离开确认持有的编辑器句柄。 */
  ref?: Ref<GlobalAgentSettingsHandle>;
  /** 当前界面语言。 */
  language: 'zh-CN' | 'en-US';
  /** 当前窗口连接的本地设置服务。 */
  client: SettingsApiClient | null;
  /** 将未保存状态汇总到窗口关闭保护。 */
  onDirtyChange(dirty: boolean): void;
  /** 重新读取也使用工作区保存、放弃、取消流程。 */
  onRequestLeave(leave: () => void): void;
}) {
  /** 当前界面文案语言。 */
  const zh = props.language === 'zh-CN';
  /** 最近一次成功读取或保存的磁盘基线。 */
  const [snapshot, setSnapshot] = useState<GlobalAgentSettingsSnapshot | null>(null);
  /** 未确认写入的正文。 */
  const [draft, setDraft] = useState('');
  /** 读写期间禁用重复动作。 */
  const [busy, setBusy] = useState<'loading' | 'saving' | null>('loading');
  /** 失败保留草稿，并在页面显示可操作的原因。 */
  const [error, setError] = useState<string | null>(null);
  /** 区分首次加载与手动保存成功。 */
  const [saved, setSaved] = useState(false);
  /** 失效读取不能覆盖新窗口连接或卸载后的状态。 */
  const generation = useRef(0);
  /** 同一保存意图可由快捷键和离开确认共同等待。 */
  const saving = useRef<Promise<boolean> | null>(null);
  /** 空白缺失文件只有手动保存才创建，不因查看就算修改。 */
  const dirty = snapshot !== null && draft !== snapshot.content;

  /** 读取成功才替换草稿，失败保留现场供重试。 */
  const load = useCallback(async () => {
    if (saving.current) return;
    /** 本次读取的归属序号。 */
    const current = ++generation.current;
    setBusy('loading');
    setError(null);
    try {
      if (!props.client) throw new Error('本地设置服务暂不可用。');
      /** 读取接口不创建文件。 */
      const next = await props.client.loadGlobalAgentSettings();
      if (current !== generation.current) return;
      setSnapshot(next);
      setDraft(next.content);
      setSaved(false);
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current === generation.current) setBusy(null);
    }
  }, [props.client]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);
  useEffect(() => {
    props.onDirtyChange(dirty || busy === 'saving');
  }, [dirty, busy, props.onDirtyChange]);
  useEffect(() => () => props.onDirtyChange(false), [props.onDirtyChange]);

  /** 保存期间正文冻结，成功后仅将该次提交设为基线。 */
  function save(): Promise<boolean> {
    if (saving.current) return saving.current;
    if (!props.client || !snapshot || busy === 'loading') return Promise.resolve(false);
    if (!dirty && snapshot.exists) return Promise.resolve(true);
    /** 当前保存对应的页面代次。 */
    const current = generation.current;
    setBusy('saving');
    setError(null);
    saving.current = props.client
      .saveGlobalAgentSettings({ content: draft, baseRevision: snapshot.revision })
      .then((metadata) => {
        if (current !== generation.current) return false;
        setSnapshot({ ...metadata, content: draft });
        setSaved(true);
        return true;
      })
      .catch((cause: unknown) => {
        if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      })
      .finally(() => {
        saving.current = null;
        if (current === generation.current) setBusy(null);
      });
    return saving.current;
  }

  useImperativeHandle(props.ref, () => ({
    save,
    discard: () => {
      setDraft(snapshot?.content ?? '');
      setError(null);
    },
  }));

  return (
    <section className="settings-product-pane global-agent-settings" aria-label={zh ? '全局规则' : 'Global rules'} aria-busy={busy !== null}>
      <header className="settings-page-heading">
        <span>
          <h2 className="settings-page-title">{zh ? '全局规则' : 'Global rules'}</h2>
          <p>{zh ? '编辑 Zeus 的 AGENTS.md。项目专属规则请放在各自仓库中。' : 'Edit the Zeus AGENTS.md. Keep project-specific rules in each repository.'}</p>
        </span>
        <div className="settings-heading-actions">
          <Button
            size="compact"
            variant="secondary"
            disabled={busy !== null}
            onClick={() =>
              props.onRequestLeave(() => {
                void load();
              })
            }
          >
            {zh ? '重新读取' : 'Reload'}
          </Button>
          <Button
            size="compact"
            disabled={busy !== null || !snapshot || (!dirty && snapshot.exists)}
            onClick={() => {
              void save();
            }}
          >
            {zh ? '保存' : 'Save'}
          </Button>
        </div>
      </header>
      <div className="global-agent-settings-info">
        {snapshot ? <code className="global-agent-settings-path">{snapshot.path}</code> : null}
        <p>{zh ? '保存后，新会话将读取更新后的规则。已有会话可能仍使用原规则。' : 'New conversations will read the saved rules. Existing conversations may still use the previous rules.'}</p>
        {snapshot && !snapshot.exists ? <p>{zh ? '文件尚未创建，点击保存后创建。内容可以为空。' : 'The file will be created when you save. Empty content is allowed.'}</p> : null}
        <span role="status" aria-live="polite">
          {busy === 'loading'
            ? zh
              ? '正在读取…'
              : 'Loading…'
            : busy === 'saving'
              ? zh
                ? '正在保存…'
                : 'Saving…'
              : error
                ? zh
                  ? '操作失败，内容已保留'
                  : 'Failed. Your content is retained.'
                : dirty
                  ? zh
                    ? '未保存'
                    : 'Unsaved'
                  : saved
                    ? zh
                      ? '已保存'
                      : 'Saved'
                    : snapshot?.exists
                      ? zh
                        ? '已读取'
                        : 'Loaded'
                      : null}
        </span>
        {error ? <p role="alert">{error}</p> : null}
      </div>
      {snapshot ? (
        <div className="global-agent-settings-editor">
          <Suspense fallback={<p role="status">{zh ? '正在打开编辑器…' : 'Opening editor…'}</p>}>
            <CodeEditor
              path={snapshot.path}
              language="markdown"
              label={zh ? 'AGENTS.md 全局规则内容' : 'AGENTS.md global rules content'}
              content={draft}
              readOnly={busy !== null}
              onChange={setDraft}
              onSave={() => {
                void save();
              }}
            />
          </Suspense>
        </div>
      ) : null}
    </section>
  );
}
