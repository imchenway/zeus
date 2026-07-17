import { describe, expect, it, vi } from 'vitest';
import { createRendererBootstrapReporter, shouldReportRendererWindowError } from '../src/preload/rendererBootstrapState.cjs';

describe('renderer bootstrap reporter', () => {
  it('reports an early renderer failure through the bootstrap channel exactly once', () => {
    const send = vi.fn();
    const reporter = createRendererBootstrapReporter({ send });

    expect(reporter.reportFailure(new Error('module evaluation failed'))).toBe('zeus:renderer-bootstrap-failed');
    expect(reporter.reportFailure(new Error('duplicate failure'))).toBeUndefined();

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('zeus:renderer-bootstrap-failed', 'module evaluation failed');
    expect(reporter.getState()).toBe('failed');
  });

  it('reports ready after the first React commit and routes a later crash through the runtime fatal channel', () => {
    const send = vi.fn();
    const reporter = createRendererBootstrapReporter({ send });

    expect(reporter.reportReady()).toBe(true);
    expect(reporter.reportFailure(new Error('post-commit render failed'))).toBe('zeus:renderer-runtime-failed');
    expect(reporter.reportFailure(new Error('duplicate runtime failure'))).toBeUndefined();

    expect(send.mock.calls).toEqual([['zeus:renderer-bootstrap-ready'], ['zeus:renderer-runtime-failed', 'post-commit render failed']]);
    expect(reporter.getState()).toBe('failed');
  });

  it('treats only real JavaScript failures or pending entry assets as fatal window errors', () => {
    expect(shouldReportRendererWindowError('pending', { target: { tagName: 'SCRIPT' } })).toBe(true);
    expect(shouldReportRendererWindowError('pending', { target: { tagName: 'LINK' } })).toBe(true);
    expect(shouldReportRendererWindowError('pending', { target: { tagName: 'IMG' } })).toBe(false);
    expect(shouldReportRendererWindowError('ready', { target: { tagName: 'SCRIPT' } })).toBe(false);
    expect(shouldReportRendererWindowError('ready', { target: { tagName: 'IMG' } })).toBe(false);
    expect(shouldReportRendererWindowError('ready', { message: 'Uncaught Error: render failed', error: new Error('render failed') })).toBe(true);
  });
});
