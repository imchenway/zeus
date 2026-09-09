import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeftIcon as ArrowLeft } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { ArrowUpIcon as ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { ArrowDownIcon as ArrowDown } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { ArrowsInSimpleIcon as ArrowsInSimple } from '@phosphor-icons/react/dist/csr/ArrowsInSimple';
import { ArrowsOutSimpleIcon as ArrowsOutSimple } from '@phosphor-icons/react/dist/csr/ArrowsOutSimple';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { CrosshairSimpleIcon as CrosshairSimple } from '@phosphor-icons/react/dist/csr/CrosshairSimple';
import { DotsThreeVerticalIcon as DotsThreeVertical } from '@phosphor-icons/react/dist/csr/DotsThreeVertical';
import { GlobeSimpleIcon as GlobeSimple } from '@phosphor-icons/react/dist/csr/GlobeSimple';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { SidebarSimpleIcon as SidebarSimple } from '@phosphor-icons/react/dist/csr/SidebarSimple';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { ZeusBrowserApprovalDecision, ZeusBrowserApprovalRequest, ZeusBrowserCommand, ZeusBrowserConversationSnapshot, ZeusBrowserEvent, ZeusBrowserPreparedSubmission } from '@zeus/shared';
import { useApplicationErrorDialog, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';

/** 浏览器正文保持原生视图，标签栏可挂到会话顶栏。 */
interface BrowserWorkspaceProps {
  /** 会话顶栏的固定挂载位置；独立预览时直接显示在正文上方。 */
  toolbarHost?: HTMLElement | null;
  conversationId: string;
  initialSnapshot?: ZeusBrowserConversationSnapshot | null;
  language: 'zh-CN' | 'en-US';
  disabled?: boolean;
  suspended?: boolean;
  expanded?: boolean;
  /** 窄窗口自动全宽，避免提供点击后没有变化的分栏操作。 */
  canSplit?: boolean;
  onClose: () => void;
  onToggleExpanded: () => void;
  onResetSize: () => void;
  onStageComments: (prepared: ZeusBrowserPreparedSubmission) => void | Promise<void>;
}

/** 浏览器工具栏的中英文文案。 */
const copy = {
  'zh-CN': {
    title: '内置浏览器',
    address: '输入网址',
    stop: '停止加载',
    splitUnavailable: '窗口较窄，已自动全宽显示',
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
    deny: '拒绝',
    closeTab: '关闭标签',
    close: '关闭浏览器',
    expand: '展开浏览器',
    collapse: '恢复左右分栏',
    more: '更多浏览器操作',
    find: '在页面中查找',
    findPrevious: '上一个匹配',
    findNext: '下一个匹配',
    closeFind: '关闭查找',
    unavailable: '此处无法使用内置浏览器。',
    loading: '正在打开内置浏览器…',
    loadFailed: '浏览器状态加载失败。',
    stageFailed: '无法将批注添加到输入框，你仍可在浏览器中查看和编辑这些批注。',
  },
  'en-US': {
    title: 'Built-in browser',
    address: 'Enter a URL',
    stop: 'Stop loading',
    splitUnavailable: 'This window is too narrow for split view',
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
    deny: 'Deny',
    closeTab: 'Close tab',
    close: 'Close browser',
    expand: 'Expand browser',
    collapse: 'Restore split view',
    more: 'More browser actions',
    find: 'Find on page',
    findPrevious: 'Previous match',
    findNext: 'Next match',
    closeFind: 'Close find',
    unavailable: 'The built-in browser is unavailable here.',
    loading: 'Opening the built-in browser…',
    loadFailed: 'The browser state could not be loaded.',
    stageFailed: 'The comments could not be added to the composer. You can still view and edit them in the browser.',
  },
} as const;

export function BrowserWorkspace(props: BrowserWorkspaceProps) {
  const labels = copy[props.language];
  const viewportRef = useRef<HTMLDivElement | null>(null);
  /** 标签横向溢出时始终将当前标签带回可见区域。 */
  const activeTabButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusCursorRef = useRef(0);
  const closedTabIdsRef = useRef(new Set<string>());
  const stageRef = useRef(props.onStageComments);
  stageRef.current = props.onStageComments;
  const [snapshot, setSnapshot] = useState<ZeusBrowserConversationSnapshot | null>(() => (props.initialSnapshot?.conversationId === props.conversationId ? props.initialSnapshot : null));
  const [address, setAddress] = useState('');
  const [addressFocused, setAddressFocused] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  /** 查找栏占用真实高度，避免原生网页盖住输入框。 */
  const [findOpen, setFindOpen] = useState(false);
  /** 查询仅在用户提交时执行，避免每个字符产生跨进程写入。 */
  const [findText, setFindText] = useState('');
  /** 打开查找后将键盘焦点交给输入框。 */
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [staging, setStaging] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useApplicationErrorDialog(snapshot ? error : null, {
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
  });
  const activeTab = snapshot?.tabs.find((tab) => tab.id === snapshot.activeTabId) ?? null;
  const draftComments = activeTab?.comments.filter((comment) => comment.status === 'draft') ?? [];

  useEffect(() => {
    if (findOpen) findInputRef.current?.focus();
  }, [findOpen, activeTab?.id]);

  useEffect(() => {
    activeTabButtonRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTab?.id, props.toolbarHost]);

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
        const resolved = current.tabs.length ? current : await bridge.openBrowserTab!({ conversationId: props.conversationId });
        if (active) setSnapshot(resolved);
      })
      .catch((loadError) => {
        if (active) setError(loadError instanceof Error ? loadError : labels.loadFailed);
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
          command: { action: 'set_annotation_mode', enabled: !annotationMode },
        })
        .then(setSnapshot)
        .catch(setError);
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [activeTab?.annotationMode, activeTab?.id, props.conversationId]);

  useEffect(() => {
    const tabId = activeTab?.id;
    const bridge = window.zeus;
    if (!tabId || !bridge?.onNativeCloseActiveContextTab) return;
    return bridge.onNativeCloseActiveContextTab(() => {
      void closeTab(tabId);
    });
  }, [activeTab?.id]);

  useLayoutEffect(() => {
    // 沿用当前标签的原生布局通道，隐藏期间保留网页实例与页面状态。
    const bridge = window.zeus;
    // 原生网页在应用界面中的布局占位节点。
    const viewport = viewportRef.current;
    // 本次布局订阅只服务于当前标签，切换时由清理函数解除。
    const tabId = activeTab?.id;
    if (!bridge?.setBrowserLayout || !viewport || !tabId) return;
    // 只保留最新一帧的显示请求，弹窗出现时立即取消。
    let frame = 0;
    // 共用弹窗直接挂在 body 下；任一弹窗存在时原生网页都不得显示。
    const isSuspended = (): boolean => Boolean(props.suspended || document.body.querySelector(':scope > [data-zeus-primitive="modal"]'));
    // 每次提交都重新读取弹窗状态和尺寸，避免延迟回调把网页重新盖到弹窗上。
    const syncLayout = (): void => {
      if (closedTabIdsRef.current.has(tabId)) return;
      // 恢复时使用当前布局，保持弹窗期间缩放后的网页位置正确。
      const rect = viewport.getBoundingClientRect();
      void bridge.setBrowserLayout!({
        conversationId: props.conversationId,
        tabId,
        visible: !isSuspended(),
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }).catch(setError);
    };
    // 隐藏立即提交，显示仍合并到下一帧，并在提交前再次检查遮挡条件。
    const apply = (): void => {
      cancelAnimationFrame(frame);
      if (isSuspended()) syncLayout();
      else frame = requestAnimationFrame(syncLayout);
    };
    // 占位区尺寸变化继续复用同一布局入口。
    const observer = new ResizeObserver(apply);
    observer.observe(viewport);
    // 只观察 body 直属节点增删，不订阅会话正文或弹窗内部内容变化。
    const modalObserver = new MutationObserver(apply);
    modalObserver.observe(document.body, { childList: true });
    window.addEventListener('resize', apply);
    apply();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      modalObserver.disconnect();
      window.removeEventListener('resize', apply);
      if (closedTabIdsRef.current.has(tabId)) return;
      const rect = viewport.getBoundingClientRect();
      void bridge
        .setBrowserLayout?.({
          conversationId: props.conversationId,
          tabId,
          visible: false,
          bounds: { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height) },
        })
        .catch(() => undefined);
    };
  }, [activeTab?.id, commentsOpen, props.conversationId, props.suspended, snapshot?.pendingApprovals.length]);

  /** 使用系统菜单覆盖网页；动作继续复用已有命令和分栏状态。 */
  async function openMoreMenu(trigger: HTMLButtonElement): Promise<void> {
    if (moreOpen || !activeTab) return;
    setMoreOpen(true);
    try {
      const rect = trigger.getBoundingClientRect();
      const action = await window.zeus!.showBrowserMenu({
        x: rect.left,
        y: rect.bottom,
        conversationId: props.conversationId,
        tabId: activeTab.id,
        language: props.language,
        canSplit: props.canSplit !== false,
        expanded: Boolean(props.expanded),
      });
      if (action === 'new_tab') await addTab();
      else if (action === 'close_tab') await closeTab(activeTab.id);
      else if (action === 'close_other_tabs') {
        for (const tab of snapshot?.tabs ?? []) {
          if (tab.id !== activeTab.id) await closeTab(tab.id);
        }
      } else if (action === 'find') {
        setFindOpen(true);
        requestAnimationFrame(() => findInputRef.current?.focus());
      } else if (action === 'toggle_expanded') props.onToggleExpanded();
      else if (action === 'reset_size') props.onResetSize();
      else if (action === 'close') props.onClose();
      else if (action) await command({ action });
    } catch (menuError) {
      setError(menuError);
    } finally {
      setMoreOpen(false);
      if (trigger.isConnected) trigger.focus();
    }
  }

  /** 收起查找时清理当前页面的搜索高亮。 */
  async function closeFind(): Promise<void> {
    setFindOpen(false);
    await command({ action: 'stop_find' });
  }

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
      setError(commandError);
    }
  }

  async function navigate(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (address.trim()) await command({ action: 'navigate', url: address });
  }

  async function activateTab(tabId: string): Promise<void> {
    try {
      if (window.zeus?.activateBrowserTab) setSnapshot(await window.zeus.activateBrowserTab({ conversationId: props.conversationId, tabId }));
    } catch (activationError) {
      setError(activationError);
    }
  }

  async function addTab(): Promise<void> {
    try {
      if (window.zeus?.openBrowserTab) setSnapshot(await window.zeus.openBrowserTab({ conversationId: props.conversationId }));
    } catch (openError) {
      setError(openError);
    }
  }

  async function closeTab(tabId: string): Promise<void> {
    if (!window.zeus?.closeBrowserTab || closedTabIdsRef.current.has(tabId)) return;
    closedTabIdsRef.current.add(tabId);
    let next: ZeusBrowserConversationSnapshot;
    try {
      next = await window.zeus.closeBrowserTab({ conversationId: props.conversationId, tabId });
    } catch (closeError) {
      closedTabIdsRef.current.delete(tabId);
      setError(closeError);
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
      setError(stageError instanceof Error ? stageError : labels.stageFailed);
    } finally {
      setStaging(false);
    }
  }

  async function clearComments(): Promise<void> {
    if (!draftComments.length || !window.confirm(labels.clearConfirm)) return;
    setCommentsOpen(false);
    await command({ action: 'clear_comments' });
  }

  async function focusNextComment(): Promise<void> {
    if (!draftComments.length) return;
    const comment = draftComments[focusCursorRef.current % draftComments.length];
    focusCursorRef.current = (focusCursorRef.current + 1) % draftComments.length;
    if (comment) await command({ action: 'focus_comment', commentId: comment.id });
  }

  /** 回应网页设备权限；AI 操作无需确认卡。 */
  async function respondToApproval(request: ZeusBrowserApprovalRequest, decision: ZeusBrowserApprovalDecision): Promise<void> {
    if (!window.zeus?.respondToBrowserApproval) return;
    await window.zeus.respondToBrowserApproval({ requestId: request.id, decision });
  }

  if (!snapshot || !activeTab) {
    return (
      <section className="browser-workspace browser-workspace-loading" data-loading={!error || undefined} aria-label={labels.title}>
        {!error ? (
          <span className="browser-workspace-loading-symbol" aria-hidden="true">
            <GlobeSimple weight="regular" />
          </span>
        ) : null}
        <p>{error ? <VisibleApplicationError error={error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} /> : labels.loading}</p>
      </section>
    );
  }

  /** 标签由浏览器自身管理，移到顶栏后仍复用原有切换和关闭动作。 */
  const tabStrip = (
    <div className="browser-tab-strip">
      <div className="browser-tabs" role="tablist" aria-label={labels.title}>
        {snapshot.tabs.map((tab) => (
          <div key={tab.id} className={`browser-tab-shell ${tab.id === snapshot.activeTabId ? 'selected' : ''}`}>
            <button
              ref={tab.id === snapshot.activeTabId ? activeTabButtonRef : undefined}
              type="button"
              role="tab"
              title={tab.url}
              aria-selected={tab.id === snapshot.activeTabId}
              className="browser-tab"
              onClick={() => void activateTab(tab.id)}
            >
              <GlobeSimple aria-hidden="true" weight="regular" />
              <span>{tab.url === 'about:blank' ? labels.newTab : tab.title || tab.url}</span>
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
          disabled={props.canSplit === false}
          aria-label={props.expanded ? labels.collapse : labels.expand}
          title={props.canSplit === false ? labels.splitUnavailable : props.expanded ? labels.collapse : labels.expand}
          onClick={props.onToggleExpanded}
        >
          {props.expanded ? <ArrowsInSimple aria-hidden="true" weight="regular" /> : <ArrowsOutSimple aria-hidden="true" weight="regular" />}
        </button>
        <button type="button" aria-label={labels.close} title={labels.close} onClick={props.onClose}>
          <X aria-hidden="true" weight="regular" />
        </button>
      </span>
    </div>
  );

  return (
    <section className="browser-workspace" aria-label={labels.title}>
      {props.toolbarHost ? createPortal(tabStrip, props.toolbarHost) : tabStrip}

      {activeTab.annotationMode && draftComments.length > 0 ? (
        <div className="browser-toolbar browser-annotation-toolbar">
          <span className="browser-annotation-actions browser-annotation-actions-leading">
            <button type="button" aria-label={labels.exit} title={labels.exit} onClick={() => void command({ action: 'set_annotation_mode', enabled: false })}>
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
            <button type="button" aria-label={labels.back} title={labels.back} disabled={!activeTab.canGoBack} onClick={() => void command({ action: 'back' })}>
              <ArrowLeft aria-hidden="true" weight="regular" />
            </button>
            <button type="button" aria-label={labels.forward} title={labels.forward} disabled={!activeTab.canGoForward} onClick={() => void command({ action: 'forward' })}>
              <ArrowRight aria-hidden="true" weight="regular" />
            </button>
            <button
              type="button"
              aria-label={activeTab.loading ? labels.stop : labels.reload}
              title={activeTab.loading ? labels.stop : labels.reload}
              onClick={() => void command(activeTab.loading ? { action: 'stop' } : { action: 'reload' })}
            >
              {activeTab.loading ? <X aria-hidden="true" weight="regular" /> : <ArrowsClockwise aria-hidden="true" weight="regular" />}
            </button>
          </span>
          <form className="browser-address-form" onSubmit={(event) => void navigate(event)}>
            <GlobeSimple aria-hidden="true" />
            <input
              value={addressFocused ? address : displayBrowserAddress(address)}
              aria-label={labels.address}
              placeholder={labels.address}
              onFocus={(event) => {
                const input = event.currentTarget;
                setAddressFocused(true);
                requestAnimationFrame(() => input.select());
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
              onClick={() => void command({ action: 'set_annotation_mode', enabled: !activeTab.annotationMode })}
            >
              <span className="browser-annotate-icon" aria-hidden="true">
                <ChatCircle weight="regular" />
                <Plus weight="bold" />
              </span>
              <span className="browser-annotate-label">{activeTab.annotationMode ? labels.annotatingMode : labels.annotate}</span>
              <kbd>⌘.</kbd>
            </button>
            <button type="button" className="browser-more-trigger" aria-label={labels.more} title={labels.more} aria-haspopup="menu" aria-expanded={moreOpen} onClick={(event) => void openMoreMenu(event.currentTarget)}>
              <DotsThreeVertical aria-hidden="true" weight="bold" />
            </button>
          </span>
        </div>
      )}

      {findOpen ? (
        <form
          className="browser-find-bar"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            if (findText.trim()) void command({ action: 'find', text: findText });
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            void closeFind();
          }}
        >
          <input ref={findInputRef} aria-label={labels.find} placeholder={labels.find} value={findText} maxLength={1000} onChange={(event) => setFindText(event.currentTarget.value)} />
          <button type="button" aria-label={labels.findPrevious} title={labels.findPrevious} disabled={!findText.trim()} onClick={() => void command({ action: 'find', text: findText, forward: false })}>
            <ArrowUp aria-hidden="true" />
          </button>
          <button type="submit" aria-label={labels.findNext} title={labels.findNext} disabled={!findText.trim()}>
            <ArrowDown aria-hidden="true" />
          </button>
          <button type="button" aria-label={labels.closeFind} title={labels.closeFind} onClick={() => void closeFind()}>
            <X aria-hidden="true" />
          </button>
        </form>
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
                    <button type="button" className="browser-comment-focus" onClick={() => void command({ action: 'focus_comment', commentId: comment.id })}>
                      <span>{comment.number}</span>
                      <strong>{comment.body}</strong>
                      <small>{comment.anchor.accessibleName || comment.anchor.immediateText || comment.anchor.kind}</small>
                    </button>
                    <button type="button" className="browser-comment-delete" aria-label={labels.delete} title={labels.delete} onClick={() => void command({ action: 'delete_comment', commentId: comment.id })}>
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
