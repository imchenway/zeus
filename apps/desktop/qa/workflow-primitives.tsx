import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { createDashboardClient, type DashboardClient } from '../src/renderer/dashboardClient.js';
import { DigitalTeamWorkspace, type DigitalTeamEntrySelection } from '../src/renderer/features/digital-teams/DigitalTeamWorkspace.js';
import type { ProjectRecord } from '../src/renderer/features/projects/projectContracts.js';
import '../src/renderer/styles.css';
import '../src/renderer/ui/primitives.css';
import '../src/renderer/agentdesk-theme.css';
import '../src/renderer/features/digital-teams/digitalTeams.css';

/** 验收页挂载正式数字团队页面，所有保存、运行和回应都访问隔离的真实服务。 */
function WorkflowQa() {
  /** 服务启动时生成的隔离客户端与项目。 */
  const [fixture, setFixture] = useState<{ client: DashboardClient; project: ProjectRecord } | null>(null);
  /** 运行创建成功后复用正式运行视图。 */
  const [selection, setSelection] = useState<DigitalTeamEntrySelection>({ kind: 'manage' });
  /** 保留真实业务拒绝用于本轮验收。 */
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetch('/qa/.workflow-fixture.json')
      .then((response) => response.json())
      .then((data) => setFixture({ project: data.project, client: createDashboardClient({ baseUrl: 'http://127.0.0.1:18535', apiToken: data.apiToken }) }))
      .catch((cause) => setError(String(cause)));
  }, []);
  /** 正式 Core 接纳新任务与冻结图后才切换到运行视图。 */
  const start = async (templateId: string, projectId: string): Promise<void> => {
    if (!fixture) return;
    try {
      const template = (await fixture.client.loadDigitalTeamTemplates()).find((item) => item.id === templateId)!;
      const projection = await fixture.client.createDigitalTeamRun(projectId, { templateId, templateRevision: template.revision, title: 'ZEUS-1035 浏览器节点联调', description: '', taskFacts: {} });
      setSelection({ kind: 'run', runId: projection.run.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className="macos-ai-app zeus-shell" style={{ height: '100vh', width: '100vw', display: 'block', padding: 0 }}>
      {error ? <p role="alert">{error}</p> : null}
      {fixture ? (
        <DigitalTeamWorkspace
          key={JSON.stringify(selection)}
          client={fixture.client}
          projects={[fixture.project]}
          initialProjectId={fixture.project.id}
          initialSelection={selection}
          language="zh-CN"
          onCreateTask={(templateId, projectId) => void start(templateId, projectId)}
        />
      ) : (
        <p role="status">加载验收环境…</p>
      )}
    </div>
  );
}

/** 单一 React 根使用正式产品组件和样式。 */
const root = createRoot(document.getElementById('root')!);
root.render(<WorkflowQa />);
