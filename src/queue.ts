/**
 * Runs pipeline tasks from a queue (e.g. a Noty category) with bounded concurrency. Each task gets its own
 * worktree from runPipeline, so parallel tasks never share files; the budget governor still gates each start.
 */
export interface QueueItemResult<T, R> {
  item: T;
  status: "succeeded" | "failed" | "skipped";
  result?: R;
  error?: string;
}

export async function runQueue<T, R>(
  items: T[],
  run: (item: T, index: number) => Promise<R>,
  opts: {
    concurrency?: number;
    /** Stop starting new tasks after a failure (default true). */
    stopOnFailure?: boolean;
    isCancelled?: () => boolean;
    onDone?: (r: QueueItemResult<T, R>, index: number) => void | Promise<void>;
  } = {}
): Promise<Array<QueueItemResult<T, R>>> {
  const requested = Number.isFinite(opts.concurrency) ? Math.floor(opts.concurrency as number) : 1;
  const concurrency = Math.max(1, Math.min(4, requested));
  const stopOnFailure = opts.stopOnFailure ?? true;
  const results: Array<QueueItemResult<T, R>> = items.map((item) => ({ item, status: "skipped" }));
  let next = 0;
  let stop = false;
  const worker = async () => {
    for (;;) {
      if (stop || opts.isCancelled?.()) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { item: items[i], status: "succeeded", result: await run(items[i], i) };
      } catch (err) {
        results[i] = { item: items[i], status: "failed", error: err instanceof Error ? err.message : String(err) };
        if (stopOnFailure) stop = true;
      }
      try {
        await opts.onDone?.(results[i], i);
      } catch {
        // reporting is best effort
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
