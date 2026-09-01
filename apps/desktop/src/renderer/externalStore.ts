/** React useSyncExternalStore 使用的最小发布机制。 */
export abstract class ExternalStore<TSnapshot> {
  private readonly listeners = new Set<() => void>();

  protected constructor(protected snapshot: TSnapshot) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): TSnapshot => this.snapshot;

  protected publish(snapshot: TSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
