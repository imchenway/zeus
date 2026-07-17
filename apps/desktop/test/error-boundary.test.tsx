import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
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

  it('renders the crash recovery surface in the selected app language without leaking Chinese copy into English mode', () => {
    const html = renderToString(
      <RendererErrorBoundary appLanguage="en-US" initialError={new Error('secret=real-token stack trace')}>
        <section>正常内容</section>
      </RendererErrorBoundary>,
    );
    const source = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'ErrorBoundary.tsx'), 'utf8');
    const entry = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'main.tsx'), 'utf8');

    expect(html).toContain('Zeus interface error');
    expect(html).toContain('Refresh window');
    expect(html).toContain('The interface is safely paused');
    expect(html).toContain('aria-label="Zeus interface error boundary"');
    for (const zhCopy of ['Zeus 遇到界面错误', '刷新窗口', '界面已安全暂停', 'Zeus 界面错误边界']) {
      expect(html).not.toContain(zhCopy);
    }
    expect(source).toContain('rendererCrashCopy');
    expect(source).not.toContain('aria-label="Zeus 界面错误边界"');
    expect(entry).toContain('appLanguage={appShellSettings.appLanguage}');
    expect(entry).toContain('const appShellSettings = await client.loadAppShellSettings();');
  });

  it('uses a dedicated compact crash surface instead of the old empty-state data-panel contract', () => {
    const html = renderToString(
      <RendererErrorBoundary initialError={new Error('secret=real-token stack trace')}>
        <section>正常内容</section>
      </RendererErrorBoundary>,
    );
    const source = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'ErrorBoundary.tsx'), 'utf8');
    const css = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'styles.css'), 'utf8');

    expect(html).toContain('renderer-crash-shell');
    expect(html).toContain('renderer-crash-surface');
    expect(html).toContain('renderer-crash-status');
    expect(html).toContain('renderer-crash-copy');
    expect(html).toContain('renderer-crash-command-rail');
    expect(html).not.toContain('renderer-crash-actions');
    expect(source).not.toContain('empty-state');
    expect(source).not.toContain('data-panel');
    expect(source).not.toContain('empty-glyph');
    expect(css).toContain('崩溃兜底产品页最终覆盖');
    expect(css).not.toMatch(/(^|[\s,{>])\.empty-state(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.data-panel(?![\w-])/);
  });

  it('normalizes the crash fallback into a product recovery surface instead of a hard-coded card page', () => {
    const html = renderToString(
      <RendererErrorBoundary initialError={new Error('secret=real-token stack trace')}>
        <section>正常内容</section>
      </RendererErrorBoundary>,
    );
    const source = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'ErrorBoundary.tsx'), 'utf8');
    const css = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'styles.css'), 'utf8');

    expect(html).toContain('renderer-crash-surface');
    expect(html).not.toContain('renderer-crash-card');
    expect(source).toContain('renderer-crash-surface');
    expect(source).not.toContain('renderer-crash-card');
    expect(css).toContain('崩溃兜底产品页最终覆盖');
    for (const token of ['--zeus-crash-canvas', '--zeus-crash-surface', '--zeus-crash-line', '--zeus-crash-text', '--zeus-crash-action-bg']) {
      expect(css).toContain(token);
    }
    expect(css).toMatch(/\.renderer-crash-command-rail button\s*\{[\s\S]*background:\s*var\(--zeus-crash-action-bg\)/);
    expect(css).not.toMatch(/\.renderer-crash-command-rail button\s*\{[\s\S]*background:\s*oklch\(49% 0\.17 274\)/);
    expect(source).not.toContain('renderer-crash-actions');
    expect(css).not.toMatch(/(^|[\s,{>])\.renderer-crash-actions(?![\w-])/);
    expect(css).not.toMatch(/(^|[\s,{>])\.renderer-crash-card(?![\w-])/);
  });

  it('reports desktop-entry render failures without showing the in-page recovery surface', () => {
    const html = renderToString(
      <RendererErrorBoundary initialError={new Error('bootstrap failed')} onFatalError={() => undefined}>
        <section>正常内容</section>
      </RendererErrorBoundary>,
    );
    const source = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'ErrorBoundary.tsx'), 'utf8');

    expect(html).toBe('');
    expect(source).toContain('this.props.onFatalError?.(error, info)');
  });

  it('forwards a React-caught error to the fatal callback exactly once with its component context', () => {
    const error = new Error('initial App render failed');
    const info = { componentStack: '\n    at BrokenApp' } as Parameters<RendererErrorBoundary['componentDidCatch']>[1];
    const onFatalError = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const boundary = new RendererErrorBoundary({ children: null, onFatalError });

      boundary.componentDidCatch(error, info);

      expect(onFatalError).toHaveBeenCalledOnce();
      expect(onFatalError).toHaveBeenCalledWith(error, info);
      expect(consoleError).toHaveBeenCalledWith('Zeus renderer crashed', {
        message: error.message,
        componentStack: info.componentStack,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('wraps the desktop renderer entry so runtime render failures do not become a blank screen', () => {
    const entry = readFileSync(join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'main.tsx'), 'utf8');

    expect(entry).toContain('import { RendererErrorBoundary }');
    expect(entry).toContain('<RendererErrorBoundary');
    expect(entry).toContain('onFatalError={reportRendererFatalFailure}');
    expect(entry).toContain('</RendererErrorBoundary>');
  });
});
