import { useEffect, useId, useState } from 'react';
import type { DashboardClient } from '../dashboardClient.js';
import type { TaskWorkDeliverableRecord } from '../features/digital-employees/digitalEmployeeContracts.js';
import { TaskDeliverableContent, TaskDeliverableReader } from '../features/digital-employees/TaskDeliverableReader.js';
import type { TaskStageDeliverableRecord } from '../features/tasks/taskContracts.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { ResourceLoading } from '../ui/ResourceLoading.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';

/** 任务详情只链接已存在的交付物，阅读继续使用各自的授权内容接口。 */
export function TaskDetailDeliverables(props: { taskId: string; client: DashboardClient; language: 'zh-CN' | 'en-US'; revision: string }) {
  /** 两种保存来源可以独立读取，列表只展示实际存在的内容。 */
  const [formal, setFormal] = useState<TaskWorkDeliverableRecord[]>([]);
  const [stages, setStages] = useState<TaskStageDeliverableRecord[]>([]);
  /** 固定打开时选中的修订，后台刷新不切换正在阅读的文件。 */
  const [selected, setSelected] = useState<{ kind: 'formal'; item: TaskWorkDeliverableRecord } | { kind: 'stage'; item: TaskStageDeliverableRecord } | null>(null);
  const zh = props.language === 'zh-CN';

  useEffect(() => {
    let active = true;
    void props.client.loadTaskWorkManagement(props.taskId).then(
      (snapshot) => {
        if (active) setFormal(snapshot.deliverables);
      },
      () => undefined,
    );
    void props.client.loadTaskWorkflow(props.taskId).then(
      (snapshot) => {
        if (active) setStages(snapshot?.stages.flatMap((stage) => stage.deliverables) ?? []);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [props.taskId, props.client, props.revision]);

  if (!formal.length && !stages.length) return null;
  return (
    <section className="task-detail-block" aria-label={zh ? '交付物' : 'Deliverables'}>
      <h2 className="task-detail-section-heading">{zh ? '交付物' : 'Deliverables'}</h2>
      <ul className="task-detail-linked-list">
        {formal.map((item) => (
          <li key={item.id}>
            <Button unstyled type="button" className="task-detail-linked-task" onClick={() => setSelected({ kind: 'formal', item })}>
              <span>{item.title}</span>
              <small>
                {zh ? '修订' : 'Revision'} {item.version}
              </small>
            </Button>
          </li>
        ))}
        {stages.map((item) => (
          <li key={item.id}>
            <Button unstyled type="button" className="task-detail-linked-task" onClick={() => setSelected({ kind: 'stage', item })}>
              <span>{item.title}</span>
              <small>
                {zh ? '修订' : 'Revision'} {item.version}
              </small>
            </Button>
          </li>
        ))}
      </ul>
      {selected?.kind === 'formal' ? (
        <TaskDeliverableReader taskId={props.taskId} client={props.client} deliverable={selected.item} revisions={formal} language={props.language} onClose={() => setSelected(null)} />
      ) : selected?.kind === 'stage' ? (
        <StageDeliverableReader key={selected.item.id} taskId={props.taskId} client={props.client} item={selected.item} language={props.language} onClose={() => setSelected(null)} />
      ) : null}
    </section>
  );
}

/** 阶段交付物使用与正式成果相同的阅读、源码和查找组件。 */
function StageDeliverableReader(props: { taskId: string; client: DashboardClient; item: TaskStageDeliverableRecord; language: 'zh-CN' | 'en-US'; onClose(): void }) {
  /** 阅读弹窗标题绑定当前固定修订。 */
  const titleId = useId();
  const zh = props.language === 'zh-CN';
  /** 正文读取与重试在当前修订内进行。 */
  const [result, setResult] = useState<{ content?: string; error?: unknown }>({});
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setResult({});
    void props.client
      .loadTaskStageDeliverableContent(props.taskId, props.item.id)
      .then(({ deliverable, content }) => {
        if (deliverable.id !== props.item.id || deliverable.version !== props.item.version || deliverable.contentSha256 !== props.item.contentSha256) {
          throw new Error(zh ? '交付物修订已变化，请重新打开。' : 'The deliverable revision changed. Reopen it.');
        }
        if (active) setResult({ content });
      })
      .catch((error: unknown) => {
        if (active) setResult({ error });
      });
    return () => {
      active = false;
    };
  }, [props.taskId, props.client, props.item, retry, zh]);

  return (
    <ModalPortal rootClassName="task-deliverable-reader-root" backdropClassName="task-work-decision-backdrop" onDismiss={props.onClose} role="dialog" aria-labelledby={titleId}>
      <section className="task-deliverable-reader zeus-solid-form-surface" data-modal-surface="dialog">
        <header>
          <strong id={titleId}>{props.item.title}</strong>
          <Button variant="secondary" size="compact" onClick={props.onClose}>
            {zh ? '关闭' : 'Close'}
          </Button>
        </header>
        <div className="task-deliverable-reader-body">
          {result.content !== undefined ? (
            <TaskDeliverableContent id={props.item.id} title={props.item.title} content={result.content} language={props.language} />
          ) : result.error ? (
            <div role="alert">
              <VisibleApplicationError error={result.error} language={zh ? 'zh-CN' : 'en'} />
              <Button variant="secondary" size="compact" onClick={() => setRetry((value) => value + 1)}>
                {zh ? '重新读取' : 'Try again'}
              </Button>
            </div>
          ) : (
            <ResourceLoading label={zh ? '正在读取正文…' : 'Loading content…'} />
          )}
        </div>
      </section>
    </ModalPortal>
  );
}
