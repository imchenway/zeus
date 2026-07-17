import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LegacyChatImportSettings } from '../src/renderer/settings/LegacyChatImportSettings.js';

describe('legacy chat import settings', () => {
  it('keeps migration controls in Settings and exposes one selected import command', () => {
    const html = renderToStaticMarkup(
      <LegacyChatImportSettings
        language="en-US"
        loading={false}
        busy={false}
        error={null}
        onRefresh={vi.fn()}
        onImport={vi.fn()}
        snapshot={{
          eligible: [{ sourceConversationId: 'legacy-1', title: 'Architecture review', cwd: '/workspace/zeus' }],
          runs: [],
        }}
      />,
    );

    expect(html).toContain('Import legacy conversations');
    expect(html).toContain('Architecture review');
    expect(html).toContain('Import selected');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('Resume this conversation');
  });

  it('shows truthful progress and sanitized failure state', () => {
    const html = renderToStaticMarkup(
      <LegacyChatImportSettings
        language="zh-CN"
        loading={false}
        busy={true}
        error={null}
        onRefresh={vi.fn()}
        onImport={vi.fn()}
        snapshot={{
          eligible: [],
          runs: [
            {
              id: 'run-1',
              importId: 'provider-1',
              sourceConversationId: 'legacy-1',
              targetConversationId: null,
              status: 'failed',
              targetThreadId: null,
              failureStage: 'provider',
              failureMessage: '导入进程未完成，请重新检查。',
              createdAt: '2026-07-14T00:00:00.000Z',
              updatedAt: '2026-07-14T00:00:01.000Z',
              completedAt: '2026-07-14T00:00:01.000Z',
            },
          ],
        }}
      />,
    );

    expect(html).toContain('导入失败');
    expect(html).toContain('导入进程未完成，请重新检查。');
    expect(html).not.toContain('targetThreadId');
  });
});
