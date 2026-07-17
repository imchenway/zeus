import { describe, expect, it, vi } from 'vitest';
import { terminateAfterFatalStartup } from '../src/main/fatalStartup.js';

describe('fatal startup termination', () => {
  it('shows the generic native error and requests a graceful quit', () => {
    const startupError = new Error('local server binding failed');
    const reportError = vi.fn();
    const showGenericError = vi.fn();
    const quitApplication = vi.fn();
    const forceExit = vi.fn();

    expect(() =>
      terminateAfterFatalStartup({
        error: startupError,
        reportError,
        showGenericError,
        quitApplication,
        forceExit,
      }),
    ).not.toThrow();

    expect(reportError).toHaveBeenCalledWith('Zeus startup failed', startupError);
    expect(showGenericError).toHaveBeenCalledTimes(1);
    expect(quitApplication).toHaveBeenCalledTimes(1);
    expect(forceExit).not.toHaveBeenCalled();
  });

  it('falls back to a forced exit without leaking the error when graceful quit throws', () => {
    const quitError = new Error('quit failed');
    const reportError = vi.fn();
    const forceExit = vi.fn();

    expect(() =>
      terminateAfterFatalStartup({
        error: new Error('renderer failed'),
        reportError,
        showGenericError: vi.fn(),
        quitApplication: () => {
          throw quitError;
        },
        forceExit,
      }),
    ).not.toThrow();

    expect(reportError).toHaveBeenCalledWith('Zeus startup quit failed', quitError);
    expect(forceExit).toHaveBeenCalledOnce();
    expect(forceExit).toHaveBeenCalledWith(1);
  });

  it('never throws even when the dialog, logger, graceful quit, and forced exit all fail', () => {
    expect(() =>
      terminateAfterFatalStartup({
        error: new Error('startup failed'),
        reportError: () => {
          throw new Error('logger failed');
        },
        showGenericError: () => {
          throw new Error('dialog failed');
        },
        quitApplication: () => {
          throw new Error('quit failed');
        },
        forceExit: () => {
          throw new Error('exit failed');
        },
      }),
    ).not.toThrow();
  });
});
