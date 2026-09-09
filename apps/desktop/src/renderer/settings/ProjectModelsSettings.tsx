import { useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardClient, ProjectModelSelection, SelectablePiModel } from '../apiClient.js';
import { presentModelOptions } from '../modelOptionPresentation.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';
import { reportApplicationError } from '../ui/ApplicationErrorDialog.js';
import { SettingsPagination, settingsPage, settingsPageSize } from './SettingsPagination.js';

/** 项目模型页只读取目录、读取选择并保存选择。 */
type ProjectModelsClient = Pick<DashboardClient, 'loadSelectablePiModels' | 'loadProjectModelSelection' | 'saveProjectModelSelection'>;

/** 在有限列表中筛选和选择项目模型，保存操作始终留在视野内。 */
export function ProjectModelsSettings(props: { projectId: string; language: 'zh-CN' | 'en-US'; client: ProjectModelsClient | null }) {
  /** 当前界面语言。 */
  const zh = props.language === 'zh-CN';
  /** 从供应商配置读取的完整目录。 */
  const [models, setModels] = useState<SelectablePiModel[]>([]);
  /** 跨页共享的选择草稿，仅保存时写回。 */
  const [selection, setSelection] = useState<ProjectModelSelection>({ projectId: props.projectId, allowedModelRefs: [], defaultModelRef: null });
  /** 读取和保存期间禁止修改配置。 */
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'failed'>('loading');
  /** 保存结果或可恢复的读取失败说明。 */
  const [message, setMessage] = useState<string | null>(null);
  /** 按名称、供应商和模型身份搜索。 */
  const [searchQuery, setSearchQuery] = useState('');
  /** 用户重试读取时刷新请求。 */
  const [loadRevision, setLoadRevision] = useState(0);
  /** 供应商筛选只改变浏览范围，不改变已选配置。 */
  const [providerFilter, setProviderFilter] = useState('');
  /** 已选视图用于核对分散在不同供应商和分页中的选择。 */
  const [selectedOnly, setSelectedOnly] = useState(false);
  /** 搜索和筛选变更时回到第一页。 */
  const [requestedPage, setRequestedPage] = useState(1);
  /** 翻页后回到列表顶部，不滚动页面和操作栏。 */
  const listRef = useRef<HTMLDivElement>(null);

  /** 请求身份阻止旧项目保存结果污染当前项目。 */
  const requestScope = useRef(0);
  /** 同一帧内也阻止重复保存。 */
  const savingRef = useRef(false);

  useEffect(() => {
    requestScope.current += 1;
    savingRef.current = false;
    /** 离开项目后丢弃迟到的读取结果。 */
    let active = true;
    setRequestedPage(1);
    setSearchQuery('');
    setProviderFilter('');
    setSelectedOnly(false);
    setStatus('loading');
    setMessage(null);
    if (!props.client) {
      setModels([]);
      setSelection({ projectId: props.projectId, allowedModelRefs: [], defaultModelRef: null });
      setStatus('failed');
      return () => {
        active = false;
        requestScope.current += 1;
      };
    }
    void Promise.all([props.client.loadSelectablePiModels(), props.client.loadProjectModelSelection(props.projectId)])
      .then(([catalog, nextSelection]) => {
        if (!active) return;
        setModels(catalog);
        setSelection(nextSelection);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (!active) return;
        setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
        setStatus('failed');
      });
    return () => {
      active = false;
      requestScope.current += 1;
    };
  }, [props.client, props.projectId, loadRevision]);

  /** 目录顺序与勾选及默认模型分离，避免操作过程中条目跨页跳动。 */
  const presentation = useMemo(() => presentModelOptions(models, '', props.language), [models, props.language]);
  /** 大目录按身份索引，避免对每个已选项反复扫描目录。 */
  const modelsById = useMemo(() => new Map(models.map((model) => [model.id, model])), [models]);
  /** 勾选判断和筛选共用集合，单次查找不随已选数增长。 */
  const selectedRefs = useMemo(() => new Set(selection.allowedModelRefs), [selection.allowedModelRefs]);
  /** 默认模型选择器只提供已选且可用的模型。 */
  const selectedModels = useMemo(() => presentation.models.filter((model) => selectedRefs.has(model.id)), [presentation.models, selectedRefs]);
  /** 保留合法默认值，移除默认项后延续已有回退规则。 */
  const defaultModelRef = selection.defaultModelRef && selectedRefs.has(selection.defaultModelRef) ? selection.defaultModelRef : (selection.allowedModelRefs[0] ?? '');
  /** 可用与不可用记录共用分页，异常记录也不能无限撑高页面。 */
  const rows = useMemo(() => {
    /** 用已有模型展示规则保留供应商名称和速度、上下文标记。 */
    const availableRows = presentation.options.map((option) => ({
      id: option.value,
      label: option.label,
      providerName: modelsById.get(option.value)?.sourceName?.trim() || (zh ? '未命名供应商' : 'Unnamed provider'),
      searchText: `${option.searchText} ${option.value}`.toLocaleLowerCase(props.language),
      unavailable: false,
    }));
    /** 已失效或移出目录的选择必须保留，直到用户明确移除。 */
    const availableRefs = new Set(availableRows.map((row) => row.id));
    return availableRows.concat(
      selection.allowedModelRefs
        .filter((ref) => !availableRefs.has(ref))
        .map((ref) => ({
          id: ref,
          label: modelsById.get(ref)?.displayName || ref,
          providerName: modelsById.get(ref)?.sourceName?.trim() || (zh ? '已选但不可用' : 'Selected but unavailable'),
          searchText: `${modelsById.get(ref)?.sourceName ?? ''} ${modelsById.get(ref)?.displayName ?? ''} ${ref}`.toLocaleLowerCase(props.language),
          unavailable: true,
        })),
    );
  }, [modelsById, presentation.options, props.language, selection.allowedModelRefs, zh]);
  /** 供应商选项基于完整目录，避免搜索后入口消失。 */
  const providerOptions = useMemo(() => [{ value: '', label: zh ? '全部供应商' : 'All providers' }, ...[...new Set(rows.map((row) => row.providerName))].map((name) => ({ value: name, label: name }))], [rows, zh]);
  /** 不可用默认模型保留原名，不静默替换用户配置。 */
  const unavailableDefaultLabel = rows.find((row) => row.id === defaultModelRef && row.unavailable)?.label;
  /** 默认选择器延续项目现有的模型展示规则。 */
  const defaultPresentation = useMemo(() => presentModelOptions(selectedModels, defaultModelRef, props.language), [defaultModelRef, props.language, selectedModels]);
  /** 搜索忽略首尾空白与大小写。 */
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase(props.language);
  /** 所有筛选先执行再分页，跨页选择仍保存在同一份项目配置中。 */
  const filteredRows = useMemo(
    () => rows.filter((row) => (!providerFilter || row.providerName === providerFilter) && (!selectedOnly || selectedRefs.has(row.id)) && (!normalizedSearchQuery || row.searchText.includes(normalizedSearchQuery))),
    [normalizedSearchQuery, providerFilter, rows, selectedOnly, selectedRefs],
  );
  /** 删除末页最后一项后自动回到有效页。 */
  const page = settingsPage(filteredRows.length, requestedPage);
  /** 只渲染当前页，模型条目数量始终不超过设置页的统一上限。 */
  const pageRows = filteredRows.slice((page - 1) * settingsPageSize, page * settingsPageSize);
  /** 本页已全选时，批量按钮改为明确的本页取消操作。 */
  const pageSelected = pageRows.length > 0 && pageRows.every((row) => selectedRefs.has(row.id));

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [page, normalizedSearchQuery, providerFilter, selectedOnly]);

  /** 单项和本页批量选择共用一次更新，保留其他页及不可用项的原配置。 */
  function toggleModels(modelRefs: string[], checked: boolean): void {
    if (status !== 'ready' || savingRef.current) return;
    setMessage(null);
    setSelection((current) => {
      /** 在最新选择上增删指定身份，避免批量操作覆盖其他页面的选择。 */
      const nextRefs = new Set(current.allowedModelRefs);
      for (const ref of modelRefs) {
        if (checked) nextRefs.add(ref);
        else nextRefs.delete(ref);
      }
      /** 按原有选择顺序保留默认模型的回退目标。 */
      const allowedModelRefs = [...nextRefs];
      return {
        ...current,
        allowedModelRefs,
        defaultModelRef: current.defaultModelRef && nextRefs.has(current.defaultModelRef) ? current.defaultModelRef : (allowedModelRefs[0] ?? null),
      };
    });
  }

  /** 使用现有保存契约，并隔离切换项目后的迟到响应。 */
  async function save(): Promise<void> {
    if (!props.client || status !== 'ready' || savingRef.current || selection.projectId !== props.projectId) return;
    /** 保存发起时固定请求身份。 */
    const scope = requestScope.current;
    savingRef.current = true;
    setStatus('saving');
    setMessage(null);
    try {
      /** 后端返回值作为下一次编辑的权威配置。 */
      const saved = await props.client.saveProjectModelSelection(props.projectId, selection);
      if (scope !== requestScope.current) return;
      setSelection(saved);
      setMessage(zh ? '项目可用模型已保存。' : 'Project models saved.');
    } catch (error) {
      if (scope !== requestScope.current) return;
      setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
    } finally {
      if (scope === requestScope.current) {
        savingRef.current = false;
        setStatus('ready');
      }
    }
  }

  return (
    <section className="project-model-settings" aria-label={zh ? '项目可用模型' : 'Project models'}>
      <header className="project-model-settings-heading">
        <h2>{zh ? '项目可用模型' : 'Project models'}</h2>
        <p>
          {zh ? '选择额外模型供应商提供的模型供此项目使用。Codex 模型由 AI 连接提供，不受此列表限制。' : 'Choose models from additional providers for this project. Codex models come from AI connections and are not restricted by this list.'}
        </p>
      </header>
      <div className="project-model-settings-toolbar">
        <label className="project-model-search-field">
          <span className="sr-only">{zh ? '搜索供应商或模型' : 'Search providers or models'}</span>
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.currentTarget.value);
              setRequestedPage(1);
            }}
            placeholder={zh ? '搜索供应商或模型' : 'Search providers or models'}
            disabled={status === 'loading' || rows.length === 0}
          />
        </label>
        <ZeusSelect
          ariaLabel={zh ? '筛选供应商' : 'Filter by provider'}
          size="regular"
          value={providerFilter}
          options={providerOptions}
          disabled={status === 'loading' || rows.length === 0}
          onChange={(value) => {
            setProviderFilter(value);
            setRequestedPage(1);
          }}
          searchPlaceholder={zh ? '搜索供应商' : 'Search providers'}
          emptyLabel={zh ? '没有匹配的供应商' : 'No matching providers'}
        />
        <label className="project-model-selected-filter">
          <input
            type="checkbox"
            checked={selectedOnly}
            disabled={status === 'loading'}
            onChange={(event) => {
              setSelectedOnly(event.currentTarget.checked);
              setRequestedPage(1);
            }}
          />
          <span>{zh ? `只看已选 (${selection.allowedModelRefs.length})` : `Selected only (${selection.allowedModelRefs.length})`}</span>
        </label>
      </div>
      <div className="project-model-catalog">
        <div className="project-model-list-actions">
          <small role="status">{zh ? `显示 ${filteredRows.length} / ${rows.length} 个模型` : `${filteredRows.length} / ${rows.length} models`}</small>
          <Button
            size="compact"
            disabled={status !== 'ready' || pageRows.length === 0}
            onClick={() =>
              toggleModels(
                pageRows.map((row) => row.id),
                !pageSelected,
              )
            }
          >
            {pageSelected ? (zh ? '取消本页选择' : 'Deselect page') : zh ? '选择本页' : 'Select page'}
          </Button>
        </div>
        <div className="project-model-settings-body" ref={listRef}>
          {status === 'loading' ? <small>{zh ? '正在读取模型…' : 'Loading models…'}</small> : null}
          {status === 'failed' ? (
            <Button size="compact" onClick={() => setLoadRevision((current) => current + 1)}>
              {zh ? '重新读取模型配置' : 'Reload model configuration'}
            </Button>
          ) : null}
          {status === 'ready' && rows.length === 0 ? (
            <small className="project-model-search-empty">
              {zh ? '暂无可用的额外供应商模型，可到系统设置的“模型供应商”添加或检查配置。' : 'No additional provider models are available. Add or check configurations under Model providers in system settings.'}
            </small>
          ) : null}
          {status === 'ready' && rows.length > 0 && filteredRows.length === 0 ? (
            <div className="project-model-search-empty">
              <p>{selectedOnly ? (zh ? '当前筛选下没有已选模型。' : 'No selected models match these filters.') : zh ? '没有匹配的供应商或模型。' : 'No matching provider or model.'}</p>
              <Button
                size="compact"
                onClick={() => {
                  setSearchQuery('');
                  setProviderFilter('');
                  setSelectedOnly(false);
                  setRequestedPage(1);
                }}
              >
                {zh ? '清除筛选' : 'Clear filters'}
              </Button>
            </div>
          ) : null}
          <fieldset className="project-model-choice-list" aria-label={zh ? '可运行模型' : 'Runnable models'} disabled={status !== 'ready'}>
            {pageRows.map((row) => (
              <label key={row.id} className="project-model-choice-row" data-selected={selectedRefs.has(row.id)}>
                <input type="checkbox" checked={selectedRefs.has(row.id)} onChange={(event) => toggleModels([row.id], event.currentTarget.checked)} aria-label={`${row.providerName} / ${row.label}`} />
                <span className="project-model-choice-name" title={row.id}>
                  <strong>{row.label}</strong>
                  {row.id === defaultModelRef ? <small>{zh ? '默认' : 'Default'}</small> : null}
                  {row.unavailable ? <small>{zh ? '不可用 · 保留原配置' : 'Unavailable · Preserved'}</small> : null}
                </span>
                <small className="project-model-choice-provider" title={row.providerName}>
                  {row.providerName}
                </small>
              </label>
            ))}
          </fieldset>
        </div>
        <SettingsPagination label={zh ? '项目模型' : 'Project models'} language={props.language} total={filteredRows.length} page={page} onChange={setRequestedPage} disabled={status === 'loading'} />
      </div>
      <footer className="project-model-settings-footer">
        <span className="project-model-settings-footer-main">
          {selectedModels.length > 0 ? (
            <label className="project-model-default-field">
              <span>{zh ? '默认预选模型' : 'Default preselected model'}</span>
              <ZeusSelect
                ariaLabel={zh ? '默认预选模型' : 'Default preselected model'}
                size="regular"
                disabled={status !== 'ready'}
                value={defaultModelRef}
                onChange={(value) => {
                  if (status !== 'ready' || savingRef.current) return;
                  setMessage(null);
                  setSelection((current) => ({ ...current, defaultModelRef: value }));
                }}
                options={defaultPresentation.options}
                pinning={defaultPresentation.pinning}
                triggerLabel={unavailableDefaultLabel ? `${unavailableDefaultLabel} · ${zh ? '不可用' : 'Unavailable'}` : defaultPresentation.triggerLabel}
                searchPlaceholder={zh ? '搜索供应商或模型' : 'Search providers or models'}
                emptyLabel={zh ? '没有匹配模型' : 'No matching models'}
              />
            </label>
          ) : (
            <small>{unavailableDefaultLabel ? `${zh ? '默认模型：' : 'Default model: '}${unavailableDefaultLabel} · ${zh ? '不可用' : 'Unavailable'}` : zh ? '当前未选择可用模型。' : 'No project model is selected.'}</small>
          )}
          {message ? <small role="status">{message}</small> : null}
        </span>
        <Button variant="primary" size="compact" onClick={() => void save()} disabled={!props.client || status !== 'ready'} busy={status === 'saving'}>
          {zh ? '保存可用模型' : 'Save project models'}
        </Button>
      </footer>
    </section>
  );
}
