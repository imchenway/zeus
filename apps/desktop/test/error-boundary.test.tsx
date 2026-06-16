import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RendererErrorBoundary } from '../src/renderer/ErrorBoundary.js';

describe('renderer error boundary', () => {
  it('renders a safe Zeus fallback without leaking stack traces or secrets', () => {
    const html = renderToString(
      <RendererErrorBoundary initialError={new Error('secret=real-token stack trace')}>
        <section>正常内容</section>
      </RendererErrorBoundary>,
    );

    expect(html).toContain('Zeus 遇到界面错误');
    expect(html).toContain('请刷新窗口或重新打开 Zeus');
    expect(html).not.toContain('正常内容');
    expect(html).not.toContain('real-token');
    expect(html).not.toContain('stack trace');
  });

  it('wraps the desktop renderer entry so runtime render failures do not become a blank screen', () => {
    const entry = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'main.tsx'), 'utf8');

    expect(entry).toContain('import { RendererErrorBoundary }');
    expect(entry).toContain('<RendererErrorBoundary>');
    expect(entry).toContain('</RendererErrorBoundary>');
  });
});
