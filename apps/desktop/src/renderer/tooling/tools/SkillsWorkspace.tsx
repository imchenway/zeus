import { MotionPresence } from '../toolPageHost.js';
import { FormDialog } from '../toolPageHost.js';
import { reportApplicationError } from '../toolPageHost.js';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { Button } from '../toolPageHost.js';
import { ExtensionSourceFields, emptyExtensionSource } from './ExtensionSourceFields.js';
import type { SkillCatalog, SkillDescriptor, SkillInstallSource } from '../toolPageHost.js';
import type { NativeConversationAppClient } from '../toolPageHost.js';
import { SkillSelector, skillCatalogChangedEvent } from '../toolPageHost.js';
import { readSkillWorkflowPreferences, skillWorkflowDefinitions, writeSkillWorkflowDefault, type SkillWorkflowId } from '../toolPageHost.js';

type SkillsClient = Pick<NativeConversationAppClient, 'loadSkills' | 'installSkill' | 'removeSkill'>;

/** 独立与内嵌技能页共用目录、安装弹窗和工作流默认设置。 */
export function SkillsWorkspace(props: { client: SkillsClient | null; language: 'zh-CN' | 'en-US'; onChooseDirectory?: () => Promise<string | null>; embedded?: boolean }) {
  const zh = props.language === 'zh-CN';
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selectedScope, setSelectedScope] = useState<SkillDescriptor['scope']>('user');
  const [installOpen, setInstallOpen] = useState(false);
  /** 安装字段与插件安装共用，切换来源保留各自输入。 */
  const [source, setSource] = useState(emptyExtensionSource);
  /** 确认移除前只保存所选技能，不删除任何文件。 */
  const [pendingRemoval, setPendingRemoval] = useState<SkillDescriptor | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [preferences, setPreferences] = useState(readSkillWorkflowPreferences);

  const load = useCallback(
    async (forceReload = false) => {
      if (!props.client) {
        setError(zh ? '当前 Zeus 后台不支持管理技能。' : 'The current Zeus background service does not support skill management.');
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        setCatalog(await props.client.loadSkills(undefined, forceReload));
      } catch (reason) {
        setError(reportApplicationError(reason, { language: zh ? 'zh-CN' : 'en' }));
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
    for (const scope of ['user', 'system'] as const) groups.set(scope, []);
    for (const skill of visibleSkills) groups.set(skill.scope, [...(groups.get(skill.scope) ?? []), skill]);
    return [...groups.entries()];
  }, [visibleSkills]);

  const activeSkills = groupedSkills.find(([scope]) => scope === selectedScope)?.[1] ?? [];

  const closeInstall = () => {
    if (installing) return;
    setInstallOpen(false);
    setInstallError(null);
  };

  /** 安装成功后重新读取目录，失败时保留表单供修改。 */
  const submitInstall = async (event: FormEvent) => {
    event.preventDefault();
    if (!props.client || installing) return;
    /** 共用来源草稿转换为技能安装契约。 */
    const installSource: SkillInstallSource =
      source.kind === 'local'
        ? { kind: 'local', path: source.path.trim() }
        : {
            kind: 'git',
            repositoryUrl: source.repositoryUrl.trim(),
            ...(source.ref.trim() ? { ref: source.ref.trim() } : {}),
            ...(source.subdirectory.trim() ? { subdirectory: source.subdirectory.trim() } : {}),
          };
    setInstalling(true);
    setInstallError(null);
    try {
      await props.client.installSkill(installSource);
      setInstallOpen(false);
      setSource(emptyExtensionSource());
      await load(true);
      window.dispatchEvent(new Event(skillCatalogChangedEvent));
    } catch (reason) {
      setInstallError(reportApplicationError(reason, { language: zh ? 'zh-CN' : 'en' }));
    } finally {
      setInstalling(false);
    }
  };

  /** 用户确认后移除技能，并清理引用它的默认设置。 */
  const removeSkill = async (skill: SkillDescriptor) => {
    if (!props.client || removingId) return;
    setRemovingId(skill.id);
    setError(null);
    try {
      await props.client.removeSkill(skill.id);
      setPendingRemoval(null);
      for (const workflow of skillWorkflowDefinitions) {
        if (preferences[workflow.id] === skill.id) writeSkillWorkflowDefault(workflow.id, '');
      }
      setPreferences(readSkillWorkflowPreferences());
      await load(true);
      window.dispatchEvent(new Event(skillCatalogChangedEvent));
    } catch (reason) {
      setError(reportApplicationError(reason, { language: zh ? 'zh-CN' : 'en' }));
    } finally {
      setRemovingId(null);
    }
  };

  const changePreference = (workflow: SkillWorkflowId, skillId: string) => {
    writeSkillWorkflowDefault(workflow, skillId);
    setPreferences(readSkillWorkflowPreferences());
  };

  return (
    <section className="workspace-view skills-workspace" aria-label={zh ? '技能管理' : 'Skill management'}>
      {!props.embedded ? (
        <header className="skills-workspace-header">
          <div className="skills-workspace-title-row">
            <div>
              <h1>{zh ? '技能管理' : 'Skill management'}</h1>
              <p>{zh ? '安装一次，在推送任务、代码审查和冲突处理时直接选择。' : 'Install once, then choose a skill in task push, code review, or conflict resolution.'}</p>
            </div>
            <span className="skills-workspace-actions">
              <Button variant="secondary" size="regular" busy={loading} onClick={() => void load(true)} disabled={!props.client || loading}>
                <ArrowClockwise aria-hidden="true" weight="regular" />
                {zh ? '刷新' : 'Refresh'}
              </Button>
              <Button variant="primary" size="regular" onClick={() => setInstallOpen(true)} disabled={!props.client}>
                <Plus aria-hidden="true" weight="bold" />
                {zh ? '安装技能' : 'Install skill'}
              </Button>
            </span>
          </div>
        </header>
      ) : null}

      {props.embedded ? (
        <div className="skills-embedded-toolbar">
          <span>{zh ? '选择技能供任务、审查和冲突处理使用。' : 'Choose skills for tasks, reviews, and conflict resolution.'}</span>
          <div className="skills-workspace-actions">
            <Button busy={loading} onClick={() => void load(true)} disabled={!props.client || loading}>
              <ArrowClockwise aria-hidden="true" />
              {zh ? '刷新技能' : 'Refresh skills'}
            </Button>
            <Button variant="primary" onClick={() => setInstallOpen(true)} disabled={!props.client || installing}>
              <Plus aria-hidden="true" />
              {zh ? '安装技能' : 'Install skill'}
            </Button>
          </div>
        </div>
      ) : null}

      <section className="skills-workflow-defaults" aria-labelledby="skills-workflow-defaults-title">
        <div className="skills-section-heading">
          <div>
            <h2 id="skills-workflow-defaults-title">{zh ? '各类工作的默认技能' : 'Default skills for each workflow'}</h2>
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
            <h2 id="skills-catalog-title">{zh ? '可用技能（Skill）' : 'Available skills'}</h2>
            <p>{catalog ? `${catalog.skills.length} ${zh ? '项技能' : 'skills'}` : zh ? '读取技能目录' : 'Read the skills folder'}</p>
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
        {!loading && catalog && activeSkills.length === 0 ? (
          <div className="skills-empty-state">
            {query ? (zh ? '没有匹配的 Skill。' : 'No matching skills.') : zh ? '尚未发现 Skill。可以从本地目录或 Git 仓库安装。' : 'No skills discovered. Install one from a local directory or Git repository.'}
          </div>
        ) : null}
        <nav className="extension-tabs skills-scope-tabs" aria-label={zh ? '技能来源' : 'Skill sources'}>
          {groupedSkills.map(([scope, skills]) => (
            <button key={scope} type="button" aria-current={selectedScope === scope ? 'page' : undefined} onClick={() => setSelectedScope(scope)}>
              {scopeName(scope, zh)} <span>{skills.length}</span>
            </button>
          ))}
        </nav>
        <div className="skills-scope-groups">
          {groupedSkills
            .filter(([scope]) => scope === selectedScope)
            .map(([scope, skills]) => (
              <section key={scope} className="skills-scope-group" aria-label={scopeName(scope, zh)}>
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
                        <Button variant="danger" size="compact" busy={removingId === skill.id} disabled={Boolean(removingId)} onClick={() => setPendingRemoval(skill)}>
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

      <MotionPresence>
        {installOpen ? (
          <FormDialog
            title={zh ? '安装技能' : 'Install skill'}
            zh={zh}
            busy={installing}
            submitLabel={zh ? '安装' : 'Install'}
            submitDisabled={source.kind === 'local' ? !source.path.trim() : !source.repositoryUrl.trim()}
            onClose={closeInstall}
            onSubmit={(event) => void submitInstall(event)}
          >
            <ExtensionSourceFields
              source={source}
              onSource={setSource}
              zh={zh}
              busy={installing}
              localLabel={zh ? '技能目录或 SKILL.md' : 'Skill directory or SKILL.md'}
              onChoosePath={
                props.onChooseDirectory
                  ? async () => {
                      /** 使用系统目录选择器返回的真实路径。 */
                      const path = await props.onChooseDirectory!();
                      if (path) setSource((current) => ({ ...current, path }));
                    }
                  : undefined
              }
            />
            <p className="zeus-form-description">
              {zh
                ? '安装只复制和校验文件。使用时，指令与脚本会按工作流权限运行，请选择可信来源。'
                : 'Installation only copies and validates files. When used, instructions and scripts run with workflow permissions. Choose a trusted source.'}
            </p>
            {installError ? (
              <p className="skills-inline-error" role="alert">
                {installError}
              </p>
            ) : null}
          </FormDialog>
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {pendingRemoval ? (
          <FormDialog
            title={zh ? `移除“${pendingRemoval.name}”？` : `Remove “${pendingRemoval.name}”?`}
            description={zh ? '将删除 Zeus 用户技能目录中的对应文件，并清除引用此技能的工作流默认设置。' : 'This deletes its files from the Zeus user skills directory and clears workflow defaults that reference it.'}
            zh={zh}
            busy={Boolean(removingId)}
            danger
            submitLabel={zh ? '移除技能' : 'Remove skill'}
            onClose={() => setPendingRemoval(null)}
            onSubmit={(event) => {
              event.preventDefault();
              void removeSkill(pendingRemoval);
            }}
          />
        ) : null}
      </MotionPresence>
    </section>
  );
}

function scopeName(scope: SkillDescriptor['scope'], zh: boolean): string {
  if (scope === 'plugin-personal') return zh ? 'Plugin 内 Skill · 个人' : 'Plugin skills · Personal';
  if (scope === 'plugin-project') return zh ? 'Plugin 内 Skill · 项目' : 'Plugin skills · Project';
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
