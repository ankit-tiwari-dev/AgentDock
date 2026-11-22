export interface RefreshQueue {
  /** Fetch now, or once more after the fetch in flight finishes; any number of triggers meanwhile make one fetch. */
  trigger(): void;
  /** Drop every answer from fetches already started and fetch again at once, as after a project switch. */
  invalidate(): void;
  /** Stop fetching and drop every answer still on its way. */
  dispose(): void;
}

export interface RefreshQueueOptions<T> {
  fetch: () => Promise<T>;
  apply: (result: T) => void;
  onError?: (error: unknown) => void;
  /** Runs after each answer or error that was not dropped. */
  onSettled?: () => void;
}

export function createRefreshQueue<T>(options: RefreshQueueOptions<T>): RefreshQueue {
  let started = 0;
  let minAccepted = 1;
  let lastApplied = 0;
  let active = 0;
  let dirty = false;
  let disposed = false;

  const finish = (seq: number, outcome: { ok: true; value: T } | { ok: false; error: unknown }) => {
    active--;
    if (!disposed && seq >= minAccepted && seq > lastApplied) {
      lastApplied = seq;
      if (outcome.ok) options.apply(outcome.value);
      else options.onError?.(outcome.error);
      options.onSettled?.();
    }
    if (!disposed && dirty && active === 0) {
      dirty = false;
      run();
    }
  };

  const run = () => {
    const seq = ++started;
    active++;
    let pending: Promise<T>;
    try {
      pending = options.fetch();
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (value) => finish(seq, { ok: true, value }),
      (error: unknown) => finish(seq, { ok: false, error }),
    );
  };

  return {
    trigger() {
      if (disposed) return;
      if (active > 0) dirty = true;
      else run();
    },
    invalidate() {
      if (disposed) return;
      minAccepted = started + 1;
      dirty = false;
      run();
    },
    dispose() {
      disposed = true;
    },
  };
}
