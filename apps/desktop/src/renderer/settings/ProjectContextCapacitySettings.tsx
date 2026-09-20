import { contextCapacityChoices } from '@zeus/shared';
import { useEffect, useRef, useState } from 'react';
import type { DashboardClient } from '../apiClient.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';
import { reportApplicationError } from '../ui/ApplicationErrorDialog.js';

/** 项目级上下文容量只影响后续新会话；模型白名单与默认模型已移除，启用模型由供应商统一配置。 */
type ProjectContextCapacityClient = Pick<DashboardClient, 'loadProjectConfig' | 'saveProjectConfig'>;

/** 项目设置只保留上下文容量入口，避免再维护与“记住上次选择”重复的模型配置。 */
export function ProjectContextCapacitySettings(props: { projectId: string; language: 'zh-CN' | 'en-US'; client: ProjectContextCapacityClient | null }) {
  const zh = props.language === 'zh-CN';
  /** 空值代表沿用默认容量，保存失败时保留未提交草稿。 */
  const [contextCapacityTokens, setContextCapacityTokens] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'failed'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  /** 请求身份阻止切换项目后的迟到读取污染当前页面。 */
  const requestScope = useRef(0);
  /** 同一帧内避免重复提交。 */
  const savingRef = useRef(false);

  useEffect(() => {
    requestScope.current += 1;
    const scope = requestScope.current;
    let active = true;
    setStatus('loading');
    setMessage(null);
    if (!props.client) {
      setContextCapacityTokens(null);
      setStatus('failed');
      return () => {
        active = false;
      };
    }
    void props.client
      .loadProjectConfig(props.projectId)
      .then((config) => {
        if (!active || scope !== requestScope.current) return;
        setContextCapacityTokens(config.contextCapacityTokens ?? null);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (!active || scope !== requestScope.current) return;
        setMessage(reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' }));
        setStatus('failed');
      });
    return () => {
      active = false;
    };
  }, [props.client, props.projectId]);

  async function save(): Promise<void> {
    if (!props.client || status !== 'ready' || savingRef.current) return;
    const scope = requestScope.current;
    savingRef.current = true;
    setStatus('saving');
    setMessage(null);
    try {
      await props.client.saveProjectConfig(props.projectId, { contextCapacityTokens });
      if (scope !== requestScope.current) return;
      setMessage(zh ? '上下文容量已保存。' : 'Context capacity saved.');
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
    <section className="project-model-settings" aria-label={zh ? '项目上下文容量' : 'Project context capacity'}>
      <header className="project-model-settings-heading">
        <h2>{zh ? '上下文容量' : 'Context capacity'}</h2>
        <p>
          {zh
            ? '设置该项目后续新会话默认使用的上下文容量。模型选择不再按项目限制，供应商中启用的模型全局可用。'
            : 'Set the default context capacity for future conversations in this project. Models are no longer restricted per project; enabled provider models are available globally.'}
        </p>
      </header>
      <label className="project-model-default-field">
        <span>{zh ? '上下文容量' : 'Context capacity'}</span>
        <ZeusSelect
          ariaLabel={zh ? '上下文容量' : 'Context capacity'}
          size="regular"
          disabled={status !== 'ready'}
          value={contextCapacityTokens === null ? 'default' : String(contextCapacityTokens)}
          options={[
            { value: 'default', label: zh ? '默认' : 'Default' },
            ...[...new Set([...contextCapacityChoices, ...(contextCapacityTokens === null ? [] : [contextCapacityTokens])])]
              .sort((a, b) => a - b)
              .map((budget) => ({ value: String(budget), label: budget >= 1_000_000 ? `${budget / 1_000_000}M` : `${budget / 1000}K` })),
          ]}
          onChange={(value) => setContextCapacityTokens(value === 'default' ? null : Number(value))}
        />
      </label>
      <footer className="project-model-settings-footer">
        <span className="project-model-settings-footer-main">{message ? <small role="status">{message}</small> : null}</span>
        <Button variant="primary" size="compact" onClick={() => void save()} disabled={!props.client || status !== 'ready'} busy={status === 'saving'}>
          {zh ? '保存上下文容量' : 'Save context capacity'}
        </Button>
      </footer>
    </section>
  );
}
