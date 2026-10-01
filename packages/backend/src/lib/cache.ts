// A value read from the database and kept in this process. Readers get it straight away within
// `freshMs`; after that the old value is still returned while a single background read replaces it,
// so no reader waits for a refresh. Past `maxStaleMs` (or before the first read) callers wait for the
// read. Concurrent readers always share one read.

export interface Cached<T> {
  get(): Promise<T>;
  clear(): void;
}

export function cached<T>(load: () => Promise<T>, opts: { freshMs: number; maxStaleMs: number; expiresAt?: (value: T) => number | null }): Cached<T> {
  let value: { at: number; data: T } | null = null;
  let pending: Promise<T> | null = null;
  let generation = 0;

  const refresh = (): Promise<T> => {
    if (pending) return pending;
    const mine = generation;
    const work = load()
      .then((data) => {
        if (mine === generation) value = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        if (pending === work) pending = null;
      });
    pending = work;
    return work;
  };

  const expired = (data: T, now: number) => {
    const deadline = opts.expiresAt?.(data);
    return deadline !== undefined && deadline !== null && now >= deadline;
  };

  return {
    get() {
      const now = Date.now();
      const age = value ? now - value.at : Infinity;
      if (value && !expired(value.data, now) && age < opts.freshMs) return Promise.resolve(value.data);
      if (value && !expired(value.data, now) && age < opts.maxStaleMs) {
        // A failed background read keeps the old value; the next reader tries again.
        refresh().catch(() => {});
        return Promise.resolve(value.data);
      }
      return refresh().then((data) => {
        // 加入旧的在途读取时，它的截止可能已早于本次请求；重新读取，不延长旧快照。
        return expired(data, now) ? refresh() : data;
      });
    },
    clear() {
      generation += 1;
      value = null;
      pending = null;
    },
  };
}
