import { describe, expect, it, vi } from 'vitest';
import { createStartupCoordinator } from '../src/main/startupCoordinator.js';

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('startup coordinator', () => {
  it('coalesces concurrent main window requests behind one initialization', async () => {
    const initialization = createDeferred();
    const initialize = vi.fn(() => initialization.promise);
    const revealOrCreateMainWindow = vi.fn(async () => undefined);
    const onFatalStartupError = vi.fn(async () => undefined);
    const coordinator = createStartupCoordinator({
      initialize,
      revealOrCreateMainWindow,
      onFatalStartupError,
    });

    const firstRequest = coordinator.requestMainWindow();
    const secondRequest = coordinator.requestMainWindow();
    const thirdRequest = coordinator.requestMainWindow();

    expect(secondRequest).toBe(firstRequest);
    expect(thirdRequest).toBe(firstRequest);
    expect(initialize).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(revealOrCreateMainWindow).not.toHaveBeenCalled();
    expect(onFatalStartupError).not.toHaveBeenCalled();

    initialization.resolve();
    await firstRequest;

    expect(revealOrCreateMainWindow).toHaveBeenCalledTimes(1);
    expect(onFatalStartupError).not.toHaveBeenCalled();
  });

  it('reuses successful initialization while allowing later requests to reveal again', async () => {
    const initialize = vi.fn(async () => undefined);
    const revealOrCreateMainWindow = vi.fn(async () => undefined);
    const onFatalStartupError = vi.fn(async () => undefined);
    const coordinator = createStartupCoordinator({
      initialize,
      revealOrCreateMainWindow,
      onFatalStartupError,
    });

    await coordinator.requestMainWindow();
    await coordinator.requestMainWindow();

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(revealOrCreateMainWindow).toHaveBeenCalledTimes(2);
    expect(onFatalStartupError).not.toHaveBeenCalled();
  });

  it('routes a synchronous initialization throw to the fatal handler without rejecting the request', async () => {
    const startupError = new Error('synchronous startup failure');
    const initialize = vi.fn((): Promise<void> => {
      throw startupError;
    });
    const revealOrCreateMainWindow = vi.fn(async () => undefined);
    const onFatalStartupError = vi.fn(async () => undefined);
    const coordinator = createStartupCoordinator({
      initialize,
      revealOrCreateMainWindow,
      onFatalStartupError,
    });

    await expect(coordinator.requestMainWindow()).resolves.toBeUndefined();

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(revealOrCreateMainWindow).not.toHaveBeenCalled();
    expect(onFatalStartupError).toHaveBeenCalledTimes(1);
    expect(onFatalStartupError).toHaveBeenCalledWith(startupError);
  });

  it('routes a synchronous window reveal throw to the fatal handler without duplicate reporting', async () => {
    const revealError = new Error('synchronous reveal failure');
    const initialize = vi.fn(async () => undefined);
    const revealOrCreateMainWindow = vi.fn((): Promise<void> => {
      throw revealError;
    });
    const onFatalStartupError = vi.fn(async () => undefined);
    const coordinator = createStartupCoordinator({
      initialize,
      revealOrCreateMainWindow,
      onFatalStartupError,
    });

    await expect(coordinator.requestMainWindow()).resolves.toBeUndefined();

    expect(revealOrCreateMainWindow).toHaveBeenCalledTimes(1);
    expect(onFatalStartupError).toHaveBeenCalledTimes(1);
    expect(onFatalStartupError).toHaveBeenCalledWith(revealError);
  });

  it('routes an asynchronous window reveal rejection to the fatal handler without duplicate reporting', async () => {
    const revealError = new Error('asynchronous reveal failure');
    const initialize = vi.fn(async () => undefined);
    const revealOrCreateMainWindow = vi.fn(async () => {
      throw revealError;
    });
    const onFatalStartupError = vi.fn(async () => undefined);
    const coordinator = createStartupCoordinator({
      initialize,
      revealOrCreateMainWindow,
      onFatalStartupError,
    });

    await expect(coordinator.requestMainWindow()).resolves.toBeUndefined();

    expect(revealOrCreateMainWindow).toHaveBeenCalledTimes(1);
    expect(onFatalStartupError).toHaveBeenCalledTimes(1);
    expect(onFatalStartupError).toHaveBeenCalledWith(revealError);
  });

  it('returns one fatal promise and preserves the first error when a later window request fails', async () => {
    const firstError = new Error('first fatal failure');
    const secondError = new Error('second fatal failure');
    const laterRevealError = new Error('later reveal failure');
    const initialize = vi.fn(async () => undefined);
    const revealOrCreateMainWindow = vi.fn(async () => {
      throw laterRevealError;
    });
    const onFatalStartupError = vi.fn(async () => undefined);
    const coordinator = createStartupCoordinator({
      initialize,
      revealOrCreateMainWindow,
      onFatalStartupError,
    });

    const firstFatalRequest = coordinator.fail(firstError);
    const secondFatalRequest = coordinator.fail(secondError);

    expect(secondFatalRequest).toBe(firstFatalRequest);

    await firstFatalRequest;
    await expect(coordinator.requestMainWindow()).resolves.toBeUndefined();

    expect(revealOrCreateMainWindow).toHaveBeenCalledTimes(1);
    expect(onFatalStartupError).toHaveBeenCalledTimes(1);
    expect(onFatalStartupError).toHaveBeenCalledWith(firstError);
  });

  it('reports only the first fatal startup error across concurrent requests and explicit failures', async () => {
    const startupError = new Error('startup failed');
    const initialize = vi.fn(async () => {
      throw startupError;
    });
    const revealOrCreateMainWindow = vi.fn(async () => undefined);
    const onFatalStartupError = vi.fn(async () => undefined);
    const coordinator = createStartupCoordinator({
      initialize,
      revealOrCreateMainWindow,
      onFatalStartupError,
    });

    const firstRequest = coordinator.requestMainWindow();
    const secondRequest = coordinator.requestMainWindow();

    expect(secondRequest).toBe(firstRequest);

    await firstRequest;
    await coordinator.fail(new Error('later failure'));

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(revealOrCreateMainWindow).not.toHaveBeenCalled();
    expect(onFatalStartupError).toHaveBeenCalledTimes(1);
    expect(onFatalStartupError).toHaveBeenCalledWith(startupError);
  });
});
