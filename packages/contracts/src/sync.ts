// Reader data that a site syncs between a reader's devices (the accounts module): each collection a set of entries,
// one per item, holding the item's latest state and when it was set (`v: null` once removed). Two copies merge entry
// by entry and the later change wins, so a device that was offline cannot undo a newer change made elsewhere, and a
// first sign-in drops nothing from either side.

export interface Entry<T> {
  /** When this state was set, in ms. */
  t: number;
  v: T | null;
}
export type Entries<T> = Record<string, Entry<T>>;

/** Removals are remembered this long, so a device that comes back within it does not bring the item back. */
const FORGET_REMOVED_MS = 90 * 86_400_000;

// A total order on entries, so both sides of a merge pick the same one whatever order they meet in.
function wins<T>(e: Entry<T>, other: Entry<T>): boolean {
  if (e.t !== other.t) return e.t > other.t;
  if ((e.v === null) !== (other.v === null)) return e.v === null;
  return JSON.stringify(e.v) > JSON.stringify(other.v);
}

export function mergeEntries<T>(a: Entries<T>, b: Entries<T>): Entries<T> {
  const out: Entries<T> = { ...a };
  for (const [key, e] of Object.entries(b)) if (!out[key] || wins(e, out[key])) out[key] = e;
  return out;
}

/** Drops removals older than the window. */
export function forgetOld<T>(entries: Entries<T>, now: number): Entries<T> {
  return Object.fromEntries(Object.entries(entries).filter(([, e]) => e.v !== null || e.t >= now - FORGET_REMOVED_MS));
}

/** Entries read from the account or a browser: those that do not read are left out, the rest kept. */
export function readEntries<T>(raw: unknown, value: (v: unknown, key: string) => T | null): Entries<T> {
  if (!raw || typeof raw !== "object") return {};
  const out: Entries<T> = {};
  for (const [key, e] of Object.entries(raw as Record<string, unknown>)) {
    if (!e || typeof e !== "object") continue;
    const { t, v } = e as { t?: unknown; v?: unknown };
    if (typeof t !== "number" || !Number.isFinite(t)) continue;
    if (v === null) out[key] = { t, v: null };
    else {
      const item = value(v, key);
      if (item !== null) out[key] = { t, v: item };
    }
  }
  return out;
}

/**
 * One kind of reader data the account carries: how to read and write it in this browser, and how it becomes the
 * account document's part and back. `fingerprints` names each item for spotting what changed; `toDoc` turns the
 * browser's copy into the part, stamping changed items with when they changed (unstamped ones keep their own time);
 * `fromDoc` gives the browser's copy back.
 */
export interface Collection<Local, Part> {
  key: string;
  read: () => Local;
  write: (value: Local) => void;
  watch: (onChange: () => void) => () => void;
  fingerprints: (value: Local) => Record<string, string>;
  toDoc: (value: Local, stamps: Record<string, number>, now: number) => Part;
  merge: (cloud: Part, local: Part, now: number) => Part;
  fromDoc: (part: Part, now: number) => Local;
  readPart: (raw: unknown) => Part;
  empty: Local;
  /** How many there are, for the account panel: "23 条收藏". */
  count: (value: Local) => number;
  unit: string;
}
