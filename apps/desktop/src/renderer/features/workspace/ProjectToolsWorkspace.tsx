import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowsInSimpleIcon } from '@phosphor-icons/react/dist/csr/ArrowsInSimple';
import { ArrowsOutSimpleIcon } from '@phosphor-icons/react/dist/csr/ArrowsOutSimple';
import { MinusIcon } from '@phosphor-icons/react/dist/csr/Minus';
import type { ProjectRecord } from '../../apiClient.js';
import type { ProjectGitWorkbenchProps } from '../../git/ProjectGitWorkbench.js';
import type { ProjectGitWorkbenchSnapshot } from '../git/gitContracts.js';
import { GitPaneSeparator } from '../../git/GitPaneSeparator.js';
import { ProjectToolContext } from './projectToolContext.js';
import './projectToolsWorkspace.css';

/** Git 与源码的分支控件复用同一个工作台实例。 */
const ProjectGitWorkbench = lazy(() => import('../../git/ProjectGitWorkbench.js').then((module) => ({ default: module.ProjectGitWorkbench })));

/** 工具和底层页面共用当前项目身份，不保存任务工作区的替代身份。 */
interface ProjectToolsWorkspaceProps {
  /** 原会话、任务或全局页面保持挂载。 */
  children: ReactNode;
  /** 页面导航仍滚动主内容，不滚动项目工具。 */
  mainRef: RefObject<HTMLElement | null>;
  /** 当前选中的真实项目；临时会话不提供项目工具。 */
  project?: ProjectRecord;
  /** Git 底栏覆盖当前页面，源码和命令保留原展示方式。 */
  open: boolean;
  /** 源码可见时加载 Git，为目录提供分支控件和文件状态。 */
  sourceVisible: boolean;
  /** 全文搜索也需要文件状态，复用同一 Git 实例和刷新订阅。 */
  fileSearchOpen: boolean;
  /** Git 能力复用现有项目工作台接口。 */
  gitClient?: ProjectGitWorkbenchProps['client'];
  /** 控件文案跟随应用语言。 */
  language: 'zh-CN' | 'en-US';
  /** 源码整页提供分支控件挂载位置。 */
  branchToolbarContainer: HTMLElement | null;
  /** 源码文件状态继续读取同一 Git 快照。 */
  onSnapshot(snapshot: ProjectGitWorkbenchSnapshot | null): void;
  /** 分支操作需要显示 Git 时只打开底栏。 */
  onOpenGit(): void;
  /** 终端与 Git 共用底部覆盖区域，避免原生网页遮挡面板。 */
  terminalOpen: boolean;
  /** 项目终端通过门户挂载到页面覆盖层。 */
  terminalHostRef(host: HTMLDivElement | null): void;
  /** 会话内容主动打开时收起底部工具。 */
  onRevealSessionContext(): void;
  /** 收起不改变底层路由、项目或后台任务。 */
  onClose(): void;
}

/** Git 和终端覆盖在主页面底部，展开和调高都不改变主页面尺寸。 */
export function ProjectToolsWorkspace(props: ProjectToolsWorkspaceProps) {
  /** 底部覆盖层以当前工作区为定位和调高边界。 */
  const layoutRef = useRef<HTMLDivElement>(null);
  /** 切换工具后把键盘焦点放到新的可见面板。 */
  const panelRef = useRef<HTMLElement>(null);
  /** 关闭后回到本次工具的入口，避免焦点留在隐藏区域。 */
  const returnFocusRef = useRef<HTMLElement | null>(null);
  /** 在关闭后的布局阶段恢复焦点，避免依赖后台窗口的动画帧。 */
  const closingToolRef = useRef(false);
  /** 展开只改变覆盖高度，不重建工作台。 */
  const [expanded, setExpanded] = useState(false);
  /** 没有项目时工具状态不能占用页面空间。 */
  const open = Boolean(props.project && props.open);
  /** 全屏只改变显示，不卸载会话控制器或编辑器。 */
  const fullWidth = open && expanded;
  /** 中英文名称用于标题及焦点提示。 */
  const zh = props.language === 'zh-CN';
  /** 会话文件或浏览器主动打开时收起项目工具，原工具内容保留。 */
  const context = useMemo(() => ({ open: open || props.terminalOpen, revealSessionContext: props.onRevealSessionContext }), [open, props.terminalOpen, props.onRevealSessionContext]);
  useLayoutEffect(() => {
    if (!open) {
      if (!closingToolRef.current) return;
      /** 原入口仍可见时优先恢复，否则定位刚关闭工具的图标。 */
      const target = returnFocusRef.current;
      if (target?.isConnected && target.getClientRects().length && !target.closest('[inert], [hidden]')) target.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('[data-project-tool="git"]')?.focus({ preventScroll: true });
      closingToolRef.current = false;
      return;
    }
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 项目工具接管焦点后，原生关闭网页快捷键不再指向被覆盖的会话网页。
    window.zeus?.notifySessionContextActivity?.({ active: false, kind: 'none' });
    panelRef.current?.focus({ preventScroll: true });
  }, [open]);
  useLayoutEffect(() => {
    if (fullWidth && layoutRef.current?.querySelector('.project-main-content')?.contains(document.activeElement)) panelRef.current?.focus({ preventScroll: true });
  }, [fullWidth]);
  /** 明确关闭时恢复入口焦点；会话内容主动接管时由会话恢复自身焦点。 */
  function closePanel(): void {
    closingToolRef.current = true;
    props.onClose();
  }
  return (
    <ProjectToolContext.Provider value={context}>
      <div ref={layoutRef} className="project-tools-layout" data-tool-open={open} data-tool-full-width={fullWidth} data-tool-covered={open || props.terminalOpen}>
        <section ref={props.mainRef} className="project-main-content">
          {props.children}
        </section>
        <aside
          id="project-tool-panel"
          ref={panelRef}
          className="project-tools-panel"
          data-zeus-primitive="overlay"
          role="region"
          aria-label={`${props.project?.name ?? ''} · Git`}
          hidden={!open}
          inert={!open}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[aria-modal="true"]:not([aria-hidden="true"])')) return;
            event.preventDefault();
            event.stopPropagation();
            closePanel();
          }}
        >
          {open && !fullWidth ? <GitPaneSeparator name="project-git-height" axis="y" target=".project-tools-layout" label={zh ? '调整 Git 高度' : 'Resize Git height'} initial={55} min={20} max={95} reverse /> : null}
          <header className="project-tools-header">
            <strong>{props.project?.name} · Git</strong>
            <button
              type="button"
              aria-label={expanded ? (zh ? '恢复高度' : 'Restore height') : zh ? '全屏展开' : 'Expand to full height'}
              data-icon-tooltip={expanded ? (zh ? '恢复高度' : 'Restore height') : zh ? '全屏展开' : 'Expand to full height'}
              aria-pressed={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <ArrowsInSimpleIcon aria-hidden="true" /> : <ArrowsOutSimpleIcon aria-hidden="true" />}
            </button>
            <button type="button" aria-label={zh ? '最小化 Git' : 'Minimize Git'} data-icon-tooltip={zh ? '最小化 Git' : 'Minimize Git'} onClick={closePanel}>
              <MinusIcon aria-hidden="true" />
            </button>
          </header>
          {props.project ? <ProjectGitPanel key={props.project.id} {...props} /> : null}
        </aside>
        <div className="project-terminal-overlay-host" ref={props.terminalHostRef} />
      </div>
    </ProjectToolContext.Provider>
  );
}

/** 每个项目只有一个 Git 实例，收起保留提交草稿和工作台位置。 */
function ProjectGitPanel(props: ProjectToolsWorkspaceProps) {
  /** 首次打开 Git、源码或文件搜索时加载，随后保留到切换项目。 */
  const [mounted, setMounted] = useState(props.open || props.sourceVisible || props.fileSearchOpen);
  if (!mounted && (props.open || props.sourceVisible || props.fileSearchOpen)) setMounted(true);
  if (!props.project || !mounted) return null;
  return (
    <div className="project-tool-content">
      <Suspense fallback={null}>
        {props.gitClient ? (
          <ProjectGitWorkbench
            project={props.project}
            client={props.gitClient}
            language={props.language}
            branchToolbarContainer={props.sourceVisible && !props.open ? props.branchToolbarContainer : null}
            onSnapshot={props.onSnapshot}
            onOpenPanel={props.onOpenGit}
          />
        ) : (
          <p role="status">{props.language === 'zh-CN' ? 'Git 服务尚未连接。' : 'The Git service is not connected.'}</p>
        )}
      </Suspense>
    </div>
  );
}
