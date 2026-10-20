import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ArrowsInSimpleIcon } from '@phosphor-icons/react/dist/csr/ArrowsInSimple';
import { ArrowsOutSimpleIcon } from '@phosphor-icons/react/dist/csr/ArrowsOutSimple';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
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
  /** 只有 Git 使用侧栏，源码和命令保留原展示方式。 */
  open: boolean;
  /** 源码可见时加载 Git，为目录提供分支控件和文件状态。 */
  sourceVisible: boolean;
  /** Git 能力复用现有项目工作台接口。 */
  gitClient?: ProjectGitWorkbenchProps['client'];
  /** 控件文案跟随应用语言。 */
  language: 'zh-CN' | 'en-US';
  /** 源码整页提供分支控件挂载位置。 */
  branchToolbarContainer: HTMLElement | null;
  /** 源码文件状态继续读取同一 Git 快照。 */
  onSnapshot(snapshot: ProjectGitWorkbenchSnapshot | null): void;
  /** 分支操作需要显示 Git 时只打开侧栏。 */
  onOpenGit(): void;
  /** 收起不改变底层路由、项目或后台任务。 */
  onClose(): void;
}

/** 非模态项目工具布局：宽度不足或用户展开时暂时隐藏底层页面。 */
export function ProjectToolsWorkspace(props: ProjectToolsWorkspaceProps) {
  /** 用实际工作区宽度判断能否并排，而非只读取窗口宽度。 */
  const layoutRef = useRef<HTMLDivElement>(null);
  /** 切换工具后把键盘焦点放到新的可见面板。 */
  const panelRef = useRef<HTMLElement>(null);
  /** 关闭后回到本次工具的入口，避免焦点留在隐藏区域。 */
  const returnFocusRef = useRef<HTMLElement | null>(null);
  /** 在关闭后的布局阶段恢复焦点，避免依赖后台窗口的动画帧。 */
  const closingToolRef = useRef(false);
  /** 用户选择的全屏与窗口宽度触发的全屏分开，窗口变宽后恢复分栏。 */
  const [expanded, setExpanded] = useState(false);
  /** 主内容和工具合计需要足够宽度，首次测量前保持单栏。 */
  const [compact, setCompact] = useState(true);
  /** 没有项目时工具状态不能占用页面空间。 */
  const open = Boolean(props.project && props.open);
  /** 全屏只改变显示，不卸载会话控制器或编辑器。 */
  const fullWidth = open && (expanded || compact);
  /** 中英文名称用于标题及焦点提示。 */
  const zh = props.language === 'zh-CN';
  /** 会话文件或浏览器主动打开时收起项目工具，原工具内容保留。 */
  const context = useMemo(() => ({ open, revealSessionContext: props.onClose }), [open, props.onClose]);
  useLayoutEffect(() => {
    /** 分栏尺寸由同一容器的 ResizeObserver 维护，两端 Electron 行为一致。 */
    const element = layoutRef.current;
    if (!element) return;
    /** 至少为主页面留 360 像素、工具留 560 像素及分隔空间。 */
    const measure = () => setCompact(element.getBoundingClientRect().width < 960);
    measure();
    /** 观察整个工作区，不因拖动内部比例反复切换模式。 */
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);
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
    // 项目工具接管焦点后，原生关闭网页快捷键不再指向隐藏的会话侧栏。
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
      <div ref={layoutRef} className="project-tools-layout" data-tool-open={open} data-tool-full-width={fullWidth}>
        <section ref={props.mainRef} className="project-main-content" hidden={fullWidth} inert={fullWidth} aria-hidden={fullWidth || undefined}>
          {props.children}
        </section>
        {open && !fullWidth ? <GitPaneSeparator name="project-tools" label={zh ? '调整页面与 Git 宽度' : 'Resize page and Git'} initial={45} min={25} max={70} /> : null}
        <aside
          id="project-tool-panel"
          ref={panelRef}
          className="project-tools-panel"
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
          <header className="project-tools-header">
            <strong>{props.project?.name} · Git</strong>
            {!compact ? (
              <button
                type="button"
                aria-label={expanded ? (zh ? '恢复分栏' : 'Restore split view') : zh ? '全屏展开' : 'Expand to full width'}
                data-icon-tooltip={expanded ? (zh ? '恢复分栏' : 'Restore split view') : zh ? '全屏展开' : 'Expand to full width'}
                aria-pressed={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? <ArrowsInSimpleIcon aria-hidden="true" /> : <ArrowsOutSimpleIcon aria-hidden="true" />}
              </button>
            ) : null}
            <button type="button" aria-label={zh ? '关闭 Git' : 'Close Git'} data-icon-tooltip={zh ? '关闭 Git' : 'Close Git'} onClick={closePanel}>
              <XIcon aria-hidden="true" />
            </button>
          </header>
          {props.project ? <ProjectGitPanel key={props.project.id} {...props} /> : null}
        </aside>
      </div>
    </ProjectToolContext.Provider>
  );
}

/** 每个项目只有一个 Git 实例，收起保留提交草稿和工作台位置。 */
function ProjectGitPanel(props: ProjectToolsWorkspaceProps) {
  /** 首次打开 Git 或源码才加载，随后保留到切换项目。 */
  const [mounted, setMounted] = useState(props.open || props.sourceVisible);
  if (!mounted && (props.open || props.sourceVisible)) setMounted(true);
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
