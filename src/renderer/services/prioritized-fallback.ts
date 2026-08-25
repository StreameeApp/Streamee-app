export type PrioritizedFallbackAttempt<TItem, TValue> = {
  item: TItem;
  value?: TValue;
  error?: unknown;
};

export interface PrioritizedFallbackOutcome<TItem, TValue> {
  winner?: { item: TItem; value: TValue };
  attempts: PrioritizedFallbackAttempt<TItem, TValue>[];
  startedItems: TItem[];
}

export function selectFallbackItems<TItem>(
  enabledItems: TItem[],
  secondaryItems: TItem[],
  prioritizedAttemptCount: number,
): TItem[] {
  return prioritizedAttemptCount === 0 ? enabledItems : secondaryItems;
}

function waitForStagger(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('Search aborted.', 'AbortError'));

  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);
    const handleAbort = () => {
      globalThis.clearTimeout(timeout);
      reject(new DOMException('Search aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

export async function runPrioritizedFallback<TItem, TValue>(
  items: TItem[],
  options: {
    staggerMs: number;
    signal?: AbortSignal;
    run: (item: TItem, signal: AbortSignal) => Promise<TValue>;
    accepts: (value: TValue) => boolean;
  },
): Promise<PrioritizedFallbackOutcome<TItem, TValue>> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  const startedItems: TItem[] = [];
  const tasks = items.map(async (item, index): Promise<PrioritizedFallbackAttempt<TItem, TValue>> => {
    try {
      if (index > 0) await waitForStagger(index * options.staggerMs, controller.signal);
      controller.signal.throwIfAborted();
      startedItems.push(item);
      return { item, value: await options.run(item, controller.signal) };
    } catch (error) {
      return { item, error };
    }
  });

  const attempts: PrioritizedFallbackAttempt<TItem, TValue>[] = [];
  try {
    for (const task of tasks) {
      const attempt = await task;
      options.signal?.throwIfAborted();
      attempts.push(attempt);
      if (attempt.value !== undefined && options.accepts(attempt.value)) {
        controller.abort();
        return {
          winner: { item: attempt.item, value: attempt.value },
          attempts,
          startedItems: [...startedItems],
        };
      }
    }
    return { attempts, startedItems: [...startedItems] };
  } finally {
    controller.abort();
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}
