import { describe, expect, it, vi } from 'vitest';
import { createRendererBootstrapMonitor } from '../src/main/rendererBootstrapMonitor.js';

function createMonitorHarness() {
  const onFailure = vi.fn();
  const monitor = createRendererBootstrapMonitor<object>({ onFailure });
  return { monitor, onFailure };
}

describe('renderer bootstrap monitor', () => {
  it('tracks a new renderer as pending without imposing an arbitrary fatal timeout', () => {
    const { monitor, onFailure } = createMonitorHarness();
    const target = {};

    monitor.watch(target);

    expect(monitor.isPending(target)).toBe(true);
    expect(monitor.isReady(target)).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('marks the trusted renderer ready and ignores later bootstrap-only failures', () => {
    const { monitor, onFailure } = createMonitorHarness();
    const target = {};

    monitor.watch(target);

    expect(monitor.markReady(target)).toBe(true);
    expect(monitor.isReady(target)).toBe(true);
    expect(monitor.markReady(target)).toBe(false);
    expect(monitor.fail(target, new Error('late bootstrap failure'))).toBe(false);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('routes only the first explicit startup failure', () => {
    const { monitor, onFailure } = createMonitorHarness();
    const target = {};
    const firstError = new Error('preload failed');

    monitor.watch(target);

    expect(monitor.fail(target, firstError)).toBe(true);
    expect(monitor.fail(target, new Error('renderer process gone'))).toBe(false);

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(target, firstError);
    expect(monitor.isPending(target)).toBe(false);
    expect(monitor.isReady(target)).toBe(false);
  });

  it('disposes a closed window without treating closure as a startup failure', () => {
    const { monitor, onFailure } = createMonitorHarness();
    const target = {};

    monitor.watch(target);
    monitor.dispose(target);

    expect(onFailure).not.toHaveBeenCalled();
    expect(monitor.isPending(target)).toBe(false);
    expect(monitor.isReady(target)).toBe(false);
  });
});
