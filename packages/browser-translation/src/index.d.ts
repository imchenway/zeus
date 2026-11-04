/** Host services are instance-scoped and contain no credentials. */
export interface PageTranslationHost {
  /** Translate plain text through the active Zeus service. */
  translate(text: string): Promise<{ trText: string; isSame: boolean }>;
  /** Reject pending page work when the upstream instance stops. */
  cancel(): void;
  /** Reposition annotations after upstream DOM writes. */
  onLayout(): void;
  /** Report page processing failures as well as transport failures. */
  onError(error: unknown): void;
  /** Resume requests only after the user clicks the upstream retry control. */
  onRetry(): void;
}
/** Start the pinned KISS page runtime with Zeus's bilingual reading policy. */
export function createPageTranslator(host: PageTranslationHost): { stop(): void };
/** Resolve a runtime-owned translation wrapper to its original element. */
export function translationSourceElement(element: Element): Element;
/** Read source text without transient translation or annotation UI. */
export function sourceText(element: Element | null): string;
/** Whether a node belongs to a translation inserted by this runtime. */
export function isTranslationNode(node: Node): boolean;
