import {useEffect, useLayoutEffect, useRef, useState, type FormEvent} from 'react';
import {ArrowLeftIcon as ArrowLeft} from '@phosphor-icons/react/dist/csr/ArrowLeft';
import {ArrowRightIcon as ArrowRight} from '@phosphor-icons/react/dist/csr/ArrowRight';
import {ArrowsClockwiseIcon as ArrowsClockwise} from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import {ArrowsInSimpleIcon as ArrowsInSimple} from '@phosphor-icons/react/dist/csr/ArrowsInSimple';
import {ArrowsOutSimpleIcon as ArrowsOutSimple} from '@phosphor-icons/react/dist/csr/ArrowsOutSimple';
import {ChatCircleIcon as ChatCircle} from '@phosphor-icons/react/dist/csr/ChatCircle';
import {CrosshairSimpleIcon as CrosshairSimple} from '@phosphor-icons/react/dist/csr/CrosshairSimple';
import {DotsThreeVerticalIcon as DotsThreeVertical} from '@phosphor-icons/react/dist/csr/DotsThreeVertical';
import {GlobeSimpleIcon as GlobeSimple} from '@phosphor-icons/react/dist/csr/GlobeSimple';
import {PlusIcon as Plus} from '@phosphor-icons/react/dist/csr/Plus';
import {RectangleIcon as Rectangle} from '@phosphor-icons/react/dist/csr/Rectangle';
import {SidebarSimpleIcon as SidebarSimple} from '@phosphor-icons/react/dist/csr/SidebarSimple';
import {TrashIcon as Trash} from '@phosphor-icons/react/dist/csr/Trash';
import {XIcon as X} from '@phosphor-icons/react/dist/csr/X';
import type {
  ZeusBrowserApprovalDecision,
  ZeusBrowserApprovalRequest,
  ZeusBrowserCommand,
  ZeusBrowserConversationSnapshot,
  ZeusBrowserEvent,
  ZeusBrowserPreparedSubmission,
} from '@zeus/shared';

interface BrowserWorkspaceProps {
  conversationId: string;
  language: 'zh-CN' | 'en-US';
  disabled?: boolean;
  suspended?: boolean;
  expanded?: boolean;
  onClose: () => void;
  onToggleExpanded: () => void;
  onResetSize: () => void;
  onStageComments: (prepared: ZeusBrowserPreparedSubmission) => void | Promise<void>;
}

const copy = {
  'zh-CN': {
    title: '内置浏览器',
    address: '输入网址或搜索内容',
    newTab: '新建标签',
    back: '后退',
    forward: '前进',
    reload: '重新加载',
    annotate: '注释',
    annotatingMode: '正在批注',
    annotating: (url: string) => `正在批注 · ${url}`,
    comments: '批注',
    stage: '发送',
    staging: '正在暂存',
    noComments: '当前页面还没有未发送批注。',
    commentHelp: '点击元素、选择文本或拖选区域，然后保存评论。',
    delete: '删除批注',
    clear: '清空当前页面批注',
    clearConfirm: '确定清空当前页面的全部未发送批注吗？',
    exit: '退出注释模式',
    focusNext: '定位下一条批注',
    showComments: '显示批注列表',
    hideComments: '隐藏批注列表',
    allowOnce: '允许一次',
    allowSite: '始终允许此站点',
    allowAll: '允许所有站点',
    deny: '拒绝',
    closeTab: '关闭标签',
    close: '关闭浏览器',
    expand: '展开浏览器',
    collapse: '恢复左右分栏',
    resetSize: '恢复默认分栏宽度',
    more: '更多浏览器操作',
    unavailable: '当前环境没有可用的内置浏览器桥接。',
    loading: '正在打开内置浏览器…',
    loadFailed: '浏览器状态加载失败。',
    stageFailed: '页面批注未能暂存到输入框，浏览器草稿仍已保留。',
  },
  'en-US': {
    title: 'Built-in browser',
    address: 'Enter a URL or search',
    newTab: 'New tab',
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    annotate: 'Annotate',
    annotatingMode: 'Annotating',
    annotating: (url: string) => `Annotating · ${url}`,
    comments: 'Comments',
    stage: 'Send',
    staging: 'Staging',
    noComments: 'This page has no unsent comments.',
    commentHelp: 'Click an element, select text, or drag an area, then save the comment.',
    delete: 'Delete comment',
    clear: 'Clear page comments',
    clearConfirm: 'Clear all unsent comments on this page?',
    exit: 'Exit annotation mode',
    focusNext: 'Focus next comment',
    showComments: 'Show comments',
    hideComments: 'Hide comments',
    allowOnce: 'Allow once',
    allowSite: 'Always allow this site',
    allowAll: 'Allow all sites',
    deny: 'Deny',
    closeTab: 'Close tab',
    close: 'Close browser',
    expand: 'Expand browser',
    collapse: 'Restore split view',
    resetSize: 'Reset split width',
    more: 'More browser actions',
    unavailable: 'The built-in browser bridge is unavailable in this environment.',
    loading: 'Opening the built-in browser…',
    loadFailed: 'The browser state could not be loaded.',
    stageFailed: 'Browser comments were not staged. The page drafts are still saved.',
  },
} as const;

export function BrowserWorkspace(props: BrowserWorkspaceProps) {
  const labels = copy[props.language];
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const focusCursorRef = useRef(0);
  const closedTabIdsRef = useRef(new Set<string>());
  const stageRef = useRef(props.onStageComments);
  stageRef.current = props.onStageComments;
  const [snapshot, setSnapshot] = useState<ZeusBrowserConversationSnapshot | null>(null);
  const [address, setAddress] = useState('');
  const [addressFocused, setAddressFocused] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [staging, setStaging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeTab = snapshot?.tabs.find((tab) => tab.id === snapshot.activeTabId) ?? null;
  const draftComments = activeTab?.comments.filter((comment) => comment.status === 'draft') ?? [];

  useEffect(() => {
    let active = true;
    const bridge = window.zeus;
    if (!bridge?.getBrowserSnapshot || !bridge.openBrowserTab || !bridge.onBrowserEvent) {
      setError(labels.unavailable);
      return;
    }
    const handleEvent = (event: ZeusBrowserEvent): void => {
      if (!active) return;
      if (event.type === 'snapshot' && event.snapshot.conversationId === props.conversationId) {
        setSnapshot(event.snapshot);
      } else if (event.type === 'error' && event.conversationId === props.conversationId) {
        setError(event.message);
      }
    };
    const unsubscribe = bridge.onBrowserEvent(handleEvent);
    void bridge
      .getBrowserSnapshot(props.conversationId)
      .then(async (current) => {
        if (!active) return;
        const resolved = current.tabs.length ? current : await bridge.openBrowserTab!({conversationId: props.conversationId});
        if (active) setSnapshot(resolved);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError.message : labels.loadFailed);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [labels.loadFailed, labels.unavailable, props.conversationId]);

  useEffect(() => {
    if (!activeTab) return;
    setAddress(activeTab.url === 'about:blank' ? '' : activeTab.url);
  }, [activeTab?.id, activeTab?.url]);

  useEffect(() => {
    const tabId = activeTab?.id;
    const annotationMode = activeTab?.annotationMode;
    const handleShortcut = (event: KeyboardEvent): void => {
      if (!tabId || !window.zeus?.runBrowserCommand || !(event.metaKey || event.ctrlKey) || event.key !== '.') return;
      event.preventDefault();
      void window.zeus
        .runBrowserCommand({
          conversationId: props.conversationId,
          tabId,
          command: {action: 'set_annotation_mode', enabled: !annotationMode},
        })
        .then(setSnapshot)
        .catch((shortcutError) => setError(shortcutError instanceof Error ? shortcutError.message : String(shortcutError)));
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [activeTab?.annotationMode, activeTab?.id, props.conversationId]);

  useLayoutEffect(() => {
    const bridge = window.zeus;
    const viewport = viewportRef.current;
    const tabId = activeTab?.id;
    if (!bridge?.setBrowserLayout || !viewport || !tabId) return;
    let frame = 0;
    const apply = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (closedTabIdsRef.current.has(tabId)) return;
        const rect = viewport.getBoundingClientRect();
        void bridge
          .setBrowserLayout!({
            conversationId: props.conversationId,
            tabId,
            visible: !props.suspended,
            bounds: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
          })
          .catch((layoutError) => setError(layoutError instanceof Error ? layoutError.message : String(layoutError)));
      });
    };
    const observer = new ResizeObserver(apply);
    observer.observe(viewport);
    window.addEventListener('resize', apply);
    apply();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', apply);
      if (closedTabIdsRef.current.has(tabId)) return;
      const rect = viewport.getBoundingClientRect();
      void bridge
        .setBrowserLayout?.({
          conversationId: props.conversationId,
          tabId,
          visible: false,
          bounds: {x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height)},
        })
        .catch(() => undefined);
    };
  }, [activeTab?.id, commentsOpen, props.conversationId, props.suspended, snapshot?.pendingApprovals.length]);

  async function command(commandValue: ZeusBrowserCommand): Promise<void> {
    if (!activeTab || !window.zeus?.runBrowserCommand) return;
    setError(null);
    try {
      setSnapshot(
        await window.zeus.runBrowserCommand({
          conversationId: props.conversationId,
          tabId: activeTab.id,
          command: commandValue,
        }),
      );
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : String(commandError));
    }
  }

  async function navigate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (address.trim()) await command({action: 'navigate', url: address});
  }

  async function activateTab(tabId: string): Promise<void> {
    if (window.zeus?.activateBrowserTab) setSnapshot(await window.zeus.activateBrowserTab({conversationId: props.conversationId, tabId}));
  }

  async function addTab(): Promise<void> {
    if (window.zeus?.openBrowserTab) setSnapshot(await window.zeus.openBrowserTab({conversationId: props.conversationId}));
  }

  async function closeTab(tabId: string): Promise<void> {
    if (!window.zeus?.closeBrowserTab) return;
    closedTabIdsRef.current.add(tabId);
    let next: ZeusBrowserConversationSnapshot;
    try {
      next = await window.zeus.closeBrowserTab({conversationId: props.conversationId, tabId});
    } catch (closeError) {
      closedTabIdsRef.current.delete(tabId);
      setError(closeError instanceof Error ? closeError.message : String(closeError));
      return;
    }
    if (next.tabs.length === 0) {
      props.onClose();
      return;
    }
    setSnapshot(next);
  }

  async function stageComments(): Promise<void> {
    if (!activeTab || !window.zeus?.prepareBrowserComments || staging || props.disabled || draftComments.length === 0) return;
    setStaging(true);
    setError(null);
    try {
      const prepared = await window.zeus.prepareBrowserComments({
        conversationId: props.conversationId,
        tabId: activeTab.id,
      });
      await stageRef.current(prepared);
    } catch (stageError) {
      setError(stageError instanceof Error ? stageError.message : labels.stageFailed);
    } finally {
      setStaging(false);
    }
  }

  async function clearComments(): Promise<void> {
    if (!draftComments.length || !window.confirm(labels.clearConfirm)) return;
    setCommentsOpen(false);
    await command({action: 'clear_comments'});
  }

  async function focusNextComment(): Promise<void> {
    if (!draftComments.length) return;
    const comment = draftComments[focusCursorRef.current % draftComments.length];
    focusCursorRef.current = (focusCursorRef.current + 1) % draftComments.length;
    if (comment) await command({action: 'focus_comment', commentId: comment.id});
  }

  async function respondToApproval(request: ZeusBrowserApprovalRequest, decision: ZeusBrowserApprovalDecision): Promise<void> {
    if (!window.zeus?.respondToBrowserApproval) return;
    if (decision === 'allow_all') {
      const confirmed = window.confirm(
        props.language === 'zh-CN'
          ? '允许所有站点会让 agent 在未来无需逐站点确认即可读取和操作网页。敏感动作仍会单独确认。确定继续吗？'
          : 'Allowing all sites lets the agent inspect and operate future sites without per-site approval. Sensitive actions still require confirmation. Continue?',
      );
      if (!confirmed) return;
    }
    await window.zeus.respondToBrowserApproval({requestId: request.id, decision});
  }

  if (!snapshot || !activeTab) {
    return (
      <section className="browser-workspace browser-workspace-loading" aria-label={labels.title}>
        <GlobeSimple aria-hidden="true" weight="regular" />
        <p>{error ?? labels.loading}</p>
      </section>
    );
  }

  return (
    <section className="browser-workspace" aria-label={labels.title}>
      <div className="browser-tab-strip">
        <div className="browser-tabs" role="tablist" aria-label={labels.title}>
          {snapshot.tabs.map((tab) => (
            <div key={tab.id} className={`browser-tab-shell ${tab.id === snapshot.activeTabId ? 'selected' : ''}`}>
              <button type="button" role="tab" aria-selected={tab.id === snapshot.activeTabId} className="browser-tab" onClick={() => void activateTab(tab.id)}>
                <GlobeSimple aria-hidden="true" weight="regular" />
                <span>{tab.title || tab.url || labels.newTab}</span>
                {tab.loading ? <span className="browser-tab-loading" aria-hidden="true" /> : null}
              </button>
              <button type="button" className="browser-tab-close" aria-label={labels.closeTab} title={labels.closeTab} onClick={() => void closeTab(tab.id)}>
                <span className="browser-tab-close-surface" aria-hidden="true">
                  <X weight="bold" />
                </span>
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="browser-new-tab" aria-label={labels.newTab} title={labels.newTab} onClick={() => void addTab()}>
          <Plus aria-hidden="true" weight="bold" />
        </button>
        <span className="browser-tab-strip-spacer" aria-hidden="true" />
        <span className="browser-view-actions">
          <button
            type="button"
            aria-label={props.expanded ? labels.collapse : labels.expand}
            title={props.expanded ? labels.collapse : labels.expand}
            onClick={props.onToggleExpanded}
          >
            {props.expanded ? <ArrowsInSimple aria-hidden="true" weight="regular" /> : <ArrowsOutSimple aria-hidden="true" weight="regular" />}
          </button>
          <button type="button" aria-label={labels.resetSize} title={labels.resetSize} onClick={props.onResetSize}>
            <Rectangle aria-hidden="true" weight="regular" />
          </button>
          <button type="button" aria-label={labels.close} title={labels.close} onClick={props.onClose}>
            <SidebarSimple aria-hidden="true" weight="regular" />
          </button>
        </span>
      </div>

      {activeTab.annotationMode && draftComments.length > 0 ? (
        <div className="browser-toolbar browser-annotation-toolbar">
          <span className="browser-annotation-actions browser-annotation-actions-leading">
            <button type="button" aria-label={labels.exit} title={labels.exit} onClick={() => void command({action: 'set_annotation_mode', enabled: false})}>
              <X aria-hidden="true" weight="bold" />
            </button>
            <button type="button" aria-label={labels.clear} title={labels.clear} disabled={draftComments.length === 0} onClick={() => void clearComments()}>
              <Trash aria-hidden="true" weight="regular" />
            </button>
          </span>
          <span className="browser-annotation-context" title={activeTab.url}>
            {labels.annotating(activeTab.url)}
          </span>
          <span className="browser-annotation-actions browser-annotation-actions-trailing">
            <button type="button" aria-label={labels.focusNext} title={labels.focusNext} disabled={draftComments.length === 0} onClick={() => void focusNextComment()}>
              <CrosshairSimple aria-hidden="true" weight="regular" />
            </button>
            <button
              type="button"
              aria-label={commentsOpen ? labels.hideComments : labels.showComments}
              title={commentsOpen ? labels.hideComments : labels.showComments}
              aria-pressed={commentsOpen}
              className={commentsOpen ? 'selected' : ''}
              onClick={() => setCommentsOpen((open) => !open)}
            >
              <SidebarSimple aria-hidden="true" weight="regular" />
            </button>
            <button type="button" className="browser-stage-comments" disabled={draftComments.length === 0 || staging || props.disabled} onClick={() => void stageComments()}>
              <span>{staging ? labels.staging : labels.stage}</span>
              <span className="browser-stage-count" aria-label={String(draftComments.length)}>
                {draftComments.length}
              </span>
            </button>
          </span>
        </div>
      ) : (
        <div className="browser-toolbar browser-navigation-toolbar">
          <span className="browser-navigation-actions">
            <button type="button" aria-label={labels.back} title={labels.back} disabled={!activeTab.canGoBack} onClick={() => void command({action: 'back'})}>
              <ArrowLeft aria-hidden="true" weight="regular" />
            </button>
            <button type="button" aria-label={labels.forward} title={labels.forward} disabled={!activeTab.canGoForward} onClick={() => void command({action: 'forward'})}>
              <ArrowRight aria-hidden="true" weight="regular" />
            </button>
            <button type="button" aria-label={labels.reload} title={labels.reload} onClick={() => void command(activeTab.loading ? {action: 'stop'} : {action: 'reload'})}>
              {activeTab.loading ? <X aria-hidden="true" weight="regular" /> : <ArrowsClockwise aria-hidden="true" weight="regular" />}
            </button>
          </span>
          <form className="browser-address-form" onSubmit={(event) => void navigate(event)}>
            <input
              value={addressFocused ? address : displayBrowserAddress(address)}
              aria-label={labels.address}
              placeholder={labels.address}
              onFocus={(event) => {
                setAddressFocused(true);
                requestAnimationFrame(() => event.currentTarget.select());
              }}
              onBlur={() => setAddressFocused(false)}
              onChange={(event) => setAddress(event.currentTarget.value)}
            />
          </form>
          <span className="browser-navigation-trailing">
            <button
              type="button"
              className={`browser-annotate-button ${activeTab.annotationMode ? 'selected' : ''}`}
              aria-label={activeTab.annotationMode ? labels.annotatingMode : labels.annotate}
              aria-pressed={activeTab.annotationMode}
              title={activeTab.annotationMode ? labels.annotatingMode : labels.annotate}
              onClick={() => void command({action: 'set_annotation_mode', enabled: !activeTab.annotationMode})}
            >
              <span className="browser-annotate-icon" aria-hidden="true">
                <ChatCircle weight="regular" />
                <Plus weight="bold" />
              </span>
              <span className="browser-annotate-label">{activeTab.annotationMode ? labels.annotatingMode : labels.annotate}</span>
              <kbd>⌘.</kbd>
            </button>
            <span
              className="browser-more"
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setMoreOpen(false);
              }}
            >
              <button
                type="button"
                className="browser-more-trigger"
                aria-label={labels.more}
                title={labels.more}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((open) => !open)}
              >
                <DotsThreeVertical aria-hidden="true" weight="bold" />
              </button>
              {moreOpen ? (
                <span className="browser-more-menu" role="menu" aria-label={labels.more}>
                  <button type="button" role="menuitem" onClick={() => void addTab().finally(() => setMoreOpen(false))}>
                    {labels.newTab}
                  </button>
                  <button type="button" role="menuitem" onClick={() => void command({action: 'reload'}).finally(() => setMoreOpen(false))}>
                    {labels.reload}
                  </button>
                  <button type="button" role="menuitem" onClick={() => {
                    setMoreOpen(false);
                    props.onClose();
                  }}>
                    {labels.close}
                  </button>
                </span>
              ) : null}
            </span>
          </span>
        </div>
      )}

      {error ? (
        <p className="browser-error-banner" role="alert">
          {error}
        </p>
      ) : null}

      <div className="browser-content-row">
        <div ref={viewportRef} className="browser-native-viewport" aria-label={activeTab.title || activeTab.url} />
        {commentsOpen || snapshot.pendingApprovals.length ? (
          <aside className="browser-comments-rail" aria-label={labels.comments}>
            {snapshot.pendingApprovals.map((request) => (
              <article className="browser-approval-card" key={request.id}>
                <strong>{request.title}</strong>
                <p>{request.detail}</p>
                <div className="browser-approval-actions">
                  <button type="button" onClick={() => void respondToApproval(request, 'deny')}>
                    {labels.deny}
                  </button>
                  <button type="button" onClick={() => void respondToApproval(request, 'allow_once')}>
                    {labels.allowOnce}
                  </button>
                  {request.kind === 'site' ? (
                    <>
                      <button type="button" onClick={() => void respondToApproval(request, 'allow_site')}>
                        {labels.allowSite}
                      </button>
                      <button type="button" onClick={() => void respondToApproval(request, 'allow_all')}>
                        {labels.allowAll}
                      </button>
                    </>
                  ) : null}
                </div>
              </article>
            ))}
            {draftComments.length === 0 ? (
              <div className="browser-comments-empty">
                <strong>{labels.noComments}</strong>
                <p>{labels.commentHelp}</p>
              </div>
            ) : (
              <ol className="browser-comment-list">
                {draftComments.map((comment) => (
                  <li key={comment.id}>
                    <button type="button" className="browser-comment-focus" onClick={() => void command({action: 'focus_comment', commentId: comment.id})}>
                      <span>{comment.number}</span>
                      <strong>{comment.body}</strong>
                      <small>{comment.anchor.accessibleName || comment.anchor.immediateText || comment.anchor.kind}</small>
                    </button>
                    <button type="button" className="browser-comment-delete" aria-label={labels.delete} title={labels.delete} onClick={() => void command({action: 'delete_comment', commentId: comment.id})}>
                      <Trash aria-hidden="true" weight="regular" />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function displayBrowserAddress(value: string): string {
  if (!value.startsWith('file://')) return value;
  try {
    return decodeURIComponent(new URL(value).pathname);
  } catch {
    return value.replace(/^file:\/\//u, '');
  }
}
