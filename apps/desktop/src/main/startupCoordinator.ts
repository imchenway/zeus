export type StartupCoordinatorOptions = {
  initialize: () => Promise<void>;
  revealOrCreateMainWindow: () => Promise<void>;
  onFatalStartupError: (error: unknown) => void | Promise<void>;
};

export type StartupCoordinator = {
  requestMainWindow: () => Promise<void>;
  fail: (error: unknown) => Promise<void>;
};

export function createStartupCoordinator(options: StartupCoordinatorOptions): StartupCoordinator {
  let initializationPromise: Promise<void> | undefined;
  let pendingRequest: Promise<void> | undefined;
  let fatalStartupPromise: Promise<void> | undefined;

  const initialize = (): Promise<void> => (initializationPromise ??= Promise.resolve().then(() => options.initialize()));

  const fail = (error: unknown): Promise<void> => (fatalStartupPromise ??= Promise.resolve().then(() => options.onFatalStartupError(error)));

  function requestMainWindow(): Promise<void> {
    if (pendingRequest) return pendingRequest;

    const request = initialize()
      .then(() => options.revealOrCreateMainWindow())
      .catch((error: unknown) => fail(error))
      .finally(() => {
        if (pendingRequest === request) pendingRequest = undefined;
      });
    pendingRequest = request;
    return request;
  }

  return { requestMainWindow, fail };
}
