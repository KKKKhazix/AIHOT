// A value read from the database and kept in this process. Readers get it straight away within
// `freshMs`; after that the old value is still returned while a single background read replaces it,
// so no reader waits for a refresh. Past `maxStaleMs` (or before the first read) callers wait for the
// read. Concurrent readers always share one read, made with the argument of the reader that starts it.

export interface Cached<T, A = void> {
  get(arg: A): Promise<T>;
}

export function cached<T, A = void>(load: (arg: A) => Promise<T>, opts: { freshMs: number; maxStaleMs: number }): Cached<T, A> {
  let value: { at: number; data: T } | null = null;
  let pending: Promise<T> | null = null;

  const refresh = (arg: A): Promise<T> => {
    if (pending) return pending;
    pending = load(arg)
      .then((data) => {
        value = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };

  return {
    get(arg) {
      const age = value ? Date.now() - value.at : Infinity;
      if (value && age < opts.freshMs) return Promise.resolve(value.data);
      if (value && age < opts.maxStaleMs) {
        // A failed background read keeps the old value; the next reader tries again.
        refresh(arg).catch(() => {});
        return Promise.resolve(value.data);
      }
      return refresh(arg);
    },
  };
}

/** Concurrent readers share one read; nothing is kept for later ones. */
export const SHARED_ONLY = { freshMs: 0, maxStaleMs: 0 };

/** One `cached` value per key, for at most `maxKeys` keys: the first key read is dropped first. */
export function cachedByKey<K, T>(name: (key: K) => string, load: (key: K) => Promise<T>, opts: { freshMs: number; maxStaleMs: number; maxKeys: number }): (key: K) => Promise<T> {
  const entries = new Map<string, Cached<T, K>>();
  return (key) => {
    const id = name(key);
    let entry = entries.get(id);
    if (!entry) {
      if (entries.size >= opts.maxKeys) entries.delete(entries.keys().next().value!);
      entries.set(id, (entry = cached(load, opts)));
    }
    return entry.get(key);
  };
}
