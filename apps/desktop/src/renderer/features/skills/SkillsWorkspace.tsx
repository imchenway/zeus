import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { Button } from '../../ui/Button.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import type { SkillCatalog, SkillDescriptor, SkillInstallSource } from '../codex/codexContracts.js';
import type { NativeConversationAppClient } from '../workspace/workspaceSupport.js';
import { SkillSelector, skillCatalogChangedEvent } from './SkillSelector.js';
import { readSkillWorkflowPreferences, skillWorkflowDefinitions, writeSkillWorkflowDefault, type SkillWorkflowId } from './skillWorkflowPreferences.js';

type SkillsClient = Pick<NativeConversationAppClient, 'loadSkills' | 'installSkill' | 'removeSkill'>;

export function SkillsWorkspace(props: { client: SkillsClient | null; language: 'zh-CN' | 'en-US'; onChooseDirectory?: () => Promise<string | null> }) {
  const zh = props.language === 'zh-CN';
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [installOpen, setInstallOpen] = useState(false);
  const [installKind, setInstallKind] = useState<'local' | 'git'>('local');
  const [localPath, setLocalPath] = useState('');
  const [repositoryUrl, setRepositoryUrl] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [subdirectory, setSubdirectory] = useState('');
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState(readSkillWorkflowPreferences);

  const load = useCallback(
    async (forceReload = false) => {
      if (!props.client) {
        setError(zh ? '当前执行宿主未提供 Skill 管理能力。' : 'Skill management is unavailable on this execution host.');
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        setCatalog(await props.client.loadSkills(undefined, forceReload));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : zh ? '无法读取 Skill' : 'Unable to load skills');
      } finally {
        setLoading(false);
      }
    },
    [props.client, zh],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const visibleSkills = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return catalog?.skills ?? [];
    return (catalog?.skills ?? []).filter((skill) => `${skill.name} ${skill.invocation} ${skill.description} ${skill.path} ${skill.scope}`.toLocaleLowerCase().includes(normalized));
  }, [catalog?.skills, query]);

  const groupedSkills = useMemo(() => {
    const groups = new Map<SkillDescriptor['scope'], SkillDescriptor[]>();
    for (const skill of visibleSkills) groups.set(skill.scope, [...(groups.get(skill.scope) ?? []), skill]);
    return [...groups.entries()];
  }, [visibleSkills]);

  const closeInstall = () => {
    if (installing) return;
    setInstallOpen(false);
    setInstallError(null);
  };

  const submitInstall = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.client || installing) return;
    const source: SkillInstallSource =
      installKind === 'local'
        ? { kind: 'local', path: localPath.trim() }
        : {
            kind: 'git',
            repositoryUrl: repositoryUrl.trim(),
            ...(gitRef.trim() ? { ref: gitRef.trim() } : {}),
            ...(subdirectory.trim() ? { subdirectory: subdirectory.trim() } : {}),
          };
    setInstalling(true);
    setInstallError(null);
    try {
      await props.client.installSkill(source);
      setInstallOpen(false);
      setLocalPath('');
      setRepositoryUrl('');
      setGitRef('');
      setSubdirectory('');
      await load(true);
      window.dispatchEvent(new Event(skillCatalogChangedEvent));
    } catch (reason) {
      setInstallError(reason instanceof Error ? reason.message : zh ? 'Skill 安装失败' : 'Skill installation failed');
    } finally {
      setInstalling(false);
    }
  };

  const removeSkill = async (skill: SkillDescriptor) => {
    if (!props.client || removingId) return;
    const confirmed = window.confirm(zh ? `移除 Skill“${skill.name}”？此操作会删除 Zeus 用户 Skill 目录中的对应文件。` : `Remove “${skill.name}”? This deletes its files from the Zeus user skills directory.`);
    if (!confirmed) return;
    setRemovingId(skill.id);
    setError(null);
    try {
      await props.client.removeSkill(skill.id);
      for (const workflow of skillWorkflowDefinitions) {
        if (preferences[workflow.id] === skill.id) writeSkillWorkflowDefault(workflow.id, '');
      }
      setPreferences(readSkillWorkflowPreferences());
      await load(true);
      window.dispatchEvent(new Event(skillCatalogChangedEvent));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : zh ? '无法移除 Skill' : 'Unable to remove skill');
    } finally {
      setRemovingId(null);
    }
  };

  const changePreference = (workflow: SkillWorkflowId, skillId: string) => {
    writeSkillWorkflowDefault(workflow, skillId);
    setPreferences(readSkillWorkflowPreferences());
  };

  return (
    <section className="workspace-view skills-workspace" aria-label={zh ? 'Skill 管理' : 'Skill management'}>
      <header className="skills-workspace-header">
        <span className="skills-workspace-kicker">ZEUS SKILLS</span>
        <div className="skills-workspace-title-row">
          <div>
            <h1>{zh ? 'Skill 管理' : 'Skill management'}</h1>
            <p>{zh ? '安装一次，在推送任务、代码审查和冲突处理时直接选择。' : 'Install once, then choose a skill in task push, code review, or conflict resolution.'}</p>
          </div>
          <span className="skills-workspace-actions">
            <Button variant="secondary" size="regular" busy={loading} onClick={() => void load(true)} disabled={!props.client || loading}>
              <ArrowClockwise aria-hidden="true" weight="regular" />
              {zh ? '刷新' : 'Refresh'}
            </Button>
            <Button variant="primary" size="regular" onClick={() => setInstallOpen(true)} disabled={!props.client}>
              <Plus aria-hidden="true" weight="bold" />
              {zh ? '安装 Skill' : 'Install skill'}
            </Button>
          </span>
        </div>
      </header>

      <section className="skills-workflow-defaults" aria-labelledby="skills-workflow-defaults-title">
        <div className="skills-section-heading">
          <div>
            <h2 id="skills-workflow-defaults-title">{zh ? '工作流默认 Skill' : 'Workflow defaults'}</h2>
            <p>{zh ? '每次打开工作流时自动带入，仍可在提交前临时改选。' : 'Preselected when a workflow opens, with a per-run override before submission.'}</p>
          </div>
        </div>
        <div className="skills-workflow-grid">
          {skillWorkflowDefinitions.map((workflow) => (
            <label key={workflow.id} className="skills-workflow-default-row">
              <span>
                <strong>{zh ? workflow.zh : workflow.en}</strong>
                <small>{workflowDescription(workflow.id, zh)}</small>
              </span>
              <SkillSelector
                client={props.client}
                catalog={catalog}
                value={preferences[workflow.id] ?? ''}
                onChange={(skillId) => changePreference(workflow.id, skillId)}
                language={props.language}
                disabled={loading}
                ariaLabel={`${zh ? workflow.zh : workflow.en} ${zh ? '默认 Skill' : 'default skill'}`}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="skills-catalog" aria-labelledby="skills-catalog-title">
        <div className="skills-section-heading skills-catalog-heading">
          <div>
            <h2 id="skills-catalog-title">{zh ? '已发现的 Skill' : 'Discovered skills'}</h2>
            <p>{catalog ? `${catalog.skills.length} ${zh ? '项' : 'items'} · ${catalog.cwd}` : zh ? '读取 Zeus Skill 目录' : 'Reading the Zeus skill catalog'}</p>
          </div>
          <input type="search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={zh ? '搜索名称、说明或路径' : 'Search name, description, or path'} aria-label={zh ? '搜索 Skill' : 'Search skills'} />
        </div>

        {error ? (
          <p className="skills-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        {catalog?.errors.length ? (
          <p className="skills-catalog-warning">{zh ? `Codex 报告 ${catalog.errors.length} 项目录错误；未被发现的 Skill 不可选择。` : `Codex reported ${catalog.errors.length} catalog errors; undiscovered skills cannot be selected.`}</p>
        ) : null}
        {loading && !catalog ? <div className="skills-empty-state">{zh ? '正在读取 Skill…' : 'Loading skills…'}</div> : null}
        {!loading && catalog && visibleSkills.length === 0 ? (
          <div className="skills-empty-state">
            {query ? (zh ? '没有匹配的 Skill。' : 'No matching skills.') : zh ? '尚未发现 Skill。可以从本地目录或 Git 仓库安装。' : 'No skills discovered. Install one from a local directory or Git repository.'}
          </div>
        ) : null}
        <div className="skills-scope-groups">
          {groupedSkills.map(([scope, skills]) => (
            <section key={scope} className="skills-scope-group" aria-label={scopeName(scope, zh)}>
              <header>
                <strong>{scopeName(scope, zh)}</strong>
                <span>{skills.length}</span>
              </header>
              <div className="skills-list">
                {skills.map((skill) => (
                  <article key={skill.id} className="skill-list-item">
                    <span className="skill-list-glyph" aria-hidden="true">
                      {skill.name.slice(0, 1).toLocaleUpperCase()}
                    </span>
                    <span className="skill-list-copy">
                      <span className="skill-list-title">
                        <strong>{skill.name}</strong>
                        <code>{skill.invocation}</code>
                      </span>
                      <span>{skill.shortDescription || skill.description}</span>
                      <small title={skill.path}>{skill.path}</small>
                    </span>
                    {skill.removable ? (
                      <Button variant="danger" size="compact" busy={removingId === skill.id} disabled={Boolean(removingId)} onClick={() => void removeSkill(skill)}>
                        <Trash aria-hidden="true" weight="regular" />
                        {zh ? '移除' : 'Remove'}
                      </Button>
                    ) : (
                      <span className="skill-list-managed-badge">{scope === 'repo' ? (zh ? '随项目' : 'Repository') : zh ? '受管理' : 'Managed'}</span>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>

      {installOpen ? (
        <ModalPortal rootClassName="skill-install-portal-root" backdropClassName="skill-install-backdrop" dismissDisabled={installing} onDismiss={closeInstall}>
          <form className="skill-install-dialog zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="skill-install-title" onSubmit={(event) => void submitInstall(event)}>
            <header>
              <div>
                <span>ZEUS SKILL</span>
                <h2 id="skill-install-title">{zh ? '安装自定义 Skill' : 'Install a custom skill'}</h2>
              </div>
              <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={closeInstall} disabled={installing}>
                <X aria-hidden="true" />
              </button>
            </header>
            <div className="skill-install-source-tabs" role="tablist" aria-label={zh ? '安装来源' : 'Install source'}>
              <button type="button" role="tab" aria-selected={installKind === 'local'} className={installKind === 'local' ? 'is-active' : ''} onClick={() => setInstallKind('local')}>
                {zh ? '本地目录' : 'Local directory'}
              </button>
              <button type="button" role="tab" aria-selected={installKind === 'git'} className={installKind === 'git' ? 'is-active' : ''} onClick={() => setInstallKind('git')}>
                {zh ? 'Git 仓库' : 'Git repository'}
              </button>
            </div>
            <div className="skill-install-fields">
              {installKind === 'local' ? (
                <label>
                  <span>{zh ? 'Skill 目录或 SKILL.md' : 'Skill directory or SKILL.md'}</span>
                  <span className="skill-install-path-control">
                    <input value={localPath} onChange={(event) => setLocalPath(event.currentTarget.value)} placeholder="/absolute/path/to/skill" autoFocus />
                    {props.onChooseDirectory ? (
                      <Button
                        variant="secondary"
                        size="regular"
                        onClick={() =>
                          void props.onChooseDirectory!().then((path) => {
                            if (path) setLocalPath(path);
                          })
                        }
                        disabled={installing}
                      >
                        <FolderOpen aria-hidden="true" />
                        {zh ? '选择' : 'Choose'}
                      </Button>
                    ) : null}
                  </span>
                </label>
              ) : (
                <>
                  <label>
                    <span>{zh ? '仓库地址' : 'Repository URL'}</span>
                    <input value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.currentTarget.value)} placeholder="https://github.com/org/repo.git" autoFocus />
                  </label>
                  <div className="skill-install-grid">
                    <label>
                      <span>{zh ? '分支、标签或 ref（可选）' : 'Branch, tag, or ref (optional)'}</span>
                      <input value={gitRef} onChange={(event) => setGitRef(event.currentTarget.value)} placeholder="main" />
                    </label>
                    <label>
                      <span>{zh ? 'Skill 子目录（可选）' : 'Skill subdirectory (optional)'}</span>
                      <input value={subdirectory} onChange={(event) => setSubdirectory(event.currentTarget.value)} placeholder="skills/my-skill" />
                    </label>
                  </div>
                </>
              )}
              <p className="skill-install-security-note">
                {zh
                  ? '安装会复制文件并验证 SKILL.md，不会执行 Skill 脚本。真正选择使用时，Skill 指令和脚本将按当前工作流权限运行；请只安装你信任的来源。'
                  : 'Installation copies files and validates SKILL.md without running scripts. Once selected, its instructions and scripts run with the workflow permissions, so install only trusted sources.'}
              </p>
              {installError ? (
                <p className="skills-inline-error" role="alert">
                  {installError}
                </p>
              ) : null}
            </div>
            <footer>
              <Button variant="secondary" size="regular" onClick={closeInstall} disabled={installing}>
                {zh ? '取消' : 'Cancel'}
              </Button>
              <Button type="submit" variant="primary" size="regular" busy={installing} disabled={installing || (installKind === 'local' ? !localPath.trim() : !repositoryUrl.trim())}>
                {installing ? (zh ? '正在安装…' : 'Installing…') : zh ? '安装' : 'Install'}
              </Button>
            </footer>
          </form>
        </ModalPortal>
      ) : null}
    </section>
  );
}

function scopeName(scope: SkillDescriptor['scope'], zh: boolean): string {
  if (scope === 'user') return zh ? '个人安装' : 'User skills';
  if (scope === 'repo') return zh ? '项目 Skill' : 'Repository skills';
  if (scope === 'system') return zh ? '系统内置' : 'System skills';
  return zh ? '管理员配置' : 'Admin skills';
}

function workflowDescription(workflow: SkillWorkflowId, zh: boolean): string {
  if (workflow === 'task_push') return zh ? '创建任务会话时使用' : 'Used for new task conversations';
  if (workflow === 'code_review') return zh ? '只读审查会话使用' : 'Used for read-only review sessions';
  return zh ? '准备冲突处理会话时使用' : 'Used while preparing conflict sessions';
}
