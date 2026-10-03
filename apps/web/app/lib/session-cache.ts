// History-entry caches keep same-document returns synchronous. Writes are coalesced after interaction;
// hiding/leaving the document flushes them so a browser back/forward reload can restore the same data.
import { readJson, storedKeys, writeRaw } from "./local-state.ts";

interface Timed { savedAt: number }
const MAX_MEMORY_ENTRIES = 20;

export function sessionCache<T extends Timed>(prefix: string, maxAge: number) {
  const memory = new Map<string, T>();
  const dirty = new Map<string, T>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listening = false;

  /** A stored entry still young enough to use; null when it is missing, unreadable or expired. */
  function stored(storedKey: string): T | null {
    const value = readJson(storedKey, "session") as T | null;
    return value && Number.isFinite(value.savedAt) && Date.now() - value.savedAt <= maxAge ? value : null;
  }
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    // Storage unavailable or full: memory still works.
    for (const [key, value] of dirty) writeRaw(prefix + key, JSON.stringify(value), "session");
    dirty.clear();
  }
  function remember(key: string, value: T) {
    memory.delete(key);
    memory.set(key, value);
    if (memory.size > MAX_MEMORY_ENTRIES) memory.delete(memory.keys().next().value!);
  }
  function peek(key: string): T | null {
    const value = memory.get(key) ?? dirty.get(key);
    if (!value) return null;
    if (Date.now() - value.savedAt <= maxAge) return value;
    memory.delete(key);
    dirty.delete(key);
    writeRaw(prefix + key, null, "session");
    return null;
  }
  function read(key: string): T | null {
    const hit = peek(key);
    if (hit) return hit;
    const value = stored(prefix + key);
    if (value) remember(key, value);
    else writeRaw(prefix + key, null, "session");
    return value;
  }
  function set(key: string, value: T) {
    remember(key, value);
    dirty.set(key, value);
    if (!listening) {
      listening = true;
      window.addEventListener("pagehide", flush);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
      // Expired history entries should not occupy the session storage quota indefinitely.
      for (const storedKey of storedKeys("session")) {
        if (storedKey.startsWith(prefix) && !stored(storedKey)) writeRaw(storedKey, null, "session");
      }
    }
    timer ??= setTimeout(flush, 50);
    // pagehide handlers may save a newer anchor after our flush handler has already run.
    if (document.visibilityState === "hidden") flush();
  }
  return { peek, read, set, flush };
}
