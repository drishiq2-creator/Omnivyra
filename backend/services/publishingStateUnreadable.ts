/**
 * A publishing-queue READ that failed - an error object OR a thrown rejection (b3 standing rule, 2026-11-19).
 *
 * It is its own state: routes answer it 503 + Retry-After with a distinct code, never as "not found",
 * "no issues" or a generic 500. Kept in its own module so route tests that mock publishingJobService
 * still see the real class. (89 plans one shared retryable-unavailable helper once S2 is on main; this
 * moves onto it then.)
 */
export class PublishingStateUnreadableError extends Error {
  constructor(readonly what: string, detail: string) {
    super(`${what} unreadable: ${detail}`);
    this.name = 'PublishingStateUnreadableError';
  }
}

/** Await a read; a rejection becomes the same named error as an error object. */
export async function readPublishingState<T>(what: string, read: PromiseLike<T>): Promise<T> {
  try {
    return await read;
  } catch (err) {
    throw new PublishingStateUnreadableError(what, (err as Error)?.message ?? 'read rejected');
  }
}
