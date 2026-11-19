/**
 * Reads contract (e9 BLOCKING, e1): the stored-result READ failed. Not "no stored result" - answered as absent, the
 * runtime re-ran the AI work uncharged (platform cost) on every transient DB failure. Typed and retryable.
 *
 * Its own module (7c, 2026-11-19): aiExecutionResultStore is mocked by several suites, and a factory that omits this
 * class makes the runtime's `err instanceof AiResultUnreadableError` throw INSIDE its catch. Here, no mock of the
 * store can remove it. The store re-exports it, so existing importers are unchanged.
 */
export class AiResultUnreadableError extends Error {
  readonly code = 'AI_RESULT_UNREADABLE' as const;
  readonly retryable = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'AiResultUnreadableError';
  }
}
