// Reader state kept only in this browser; nothing about a reader leaves it. Storage failures degrade
// silently. Keep the keys and formats once readers have data under them.
import { useSyncExternalStore } from "react";
import { beijingDate } from "@aihot/contracts/time";

export const KEYS = {
  starred: "aihot-starred-items",
  read: "aihot-read-items",
  theme: "aihot-theme",
  changelogSeen: "aihot-changelog-seen-version",
  feedbackDraft: "aihot-feedback-draft-v1",
} as const;

export const STARRED_LIMIT = 500;
export const READ_LIMIT = 5000;
export const IMPORT_MAX_CHARS = 2_000_000;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

export interface LocalStarredItem {
  id: string;
  title: string;
  summary: string | null;
  sourceName: string;
  savedAt: string;
  publishedAt: string | null;
  score: number | null;
  aiSelected: boolean;
}

function storage(kind: "local" | "session"): Storage | null {
  try {
    const s = kind === "local" ? window.localStorage : window.sessionStorage;
    return s;
  } catch {
    return null;
  }
}

function readRaw(key: string, kind: "local" | "session" = "local"): string | null {
  try {
    return storage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null, kind: "local" | "session" = "local"): boolean {
  try {
    const s = storage(kind);
    if (!s) return false;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// --- change notification (same tab via events, other tabs via the storage event) ---
const listeners = new Map<string, Set<() => void>>();
let subscribers = 0;
function emit(key?: string) {
  for (const [subscribedKey, callbacks] of listeners) {
    if (key === undefined || key === subscribedKey) for (const callback of callbacks) callback();
  }
}
function onStorage(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== storage("local")) return;
  if (event.key === null) cache.clear();
  else cache.delete(event.key);
  // Clear the snapshot once, before notifying all cards. Each key is parsed at most once.
  emit(event.key ?? undefined);
}
function subscribeKey(key: string) {
  return (listener: () => void) => {
    let callbacks = listeners.get(key);
    if (!callbacks) listeners.set(key, callbacks = new Set());
    callbacks.add(listener);
    if (subscribers++ === 0) window.addEventListener("storage", onStorage);
    return () => {
      callbacks.delete(listener);
      if (callbacks.size === 0) listeners.delete(key);
      if (--subscribers === 0) window.removeEventListener("storage", onStorage);
    };
  };
}
const subscribeStarred = subscribeKey(KEYS.starred);
const subscribeRead = subscribeKey(KEYS.read);
const subscribeTheme = subscribeKey(KEYS.theme);
const subscribeChangelog = subscribeKey(KEYS.changelogSeen);

// Snapshot cache so useSyncExternalStore gets stable references between changes.
const cache = new Map<string, unknown>();
function cached<T>(key: string, compute: () => T): T {
  if (!cache.has(key)) cache.set(key, compute());
  return cache.get(key) as T;
}
function invalidate(key: string) {
  cache.delete(key);
  emit(key);
}

// A storage event can arrive after another tab starts editing. Lock the read/merge/write as one
// operation, then read fresh values; browsers without Web Locks still avoid stale cached writes.
async function editLocalData<T>(change: () => T): Promise<T> {
  const run = () => { cache.clear(); return change(); };
  const locks = typeof window !== "undefined" ? window.navigator?.locks : undefined;
  if (!locks) return run();
  let entered = false;
  return locks.request("aihot:local-data", () => { entered = true; return run(); }).catch((error) => {
    if (entered) throw error;
    return run(); // Storage or locks may be blocked by browser privacy settings.
  });
}

// --- starred ---
function isStarredItem(v: unknown): v is LocalStarredItem {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && ID_PATTERN.test(o.id) && typeof o.title === "string";
}

/** Imported and already stored dates must be representable in the page's display timezone. */
function isDisplayableDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    beijingDate(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeStarred(v: Record<string, unknown>): LocalStarredItem {
  return {
    id: String(v.id),
    title: String(v.title),
    summary: typeof v.summary === "string" ? v.summary : null,
    sourceName: typeof v.sourceName === "string" ? v.sourceName : "",
    savedAt: isDisplayableDate(v.savedAt) ? v.savedAt : new Date().toISOString(),
    publishedAt: isDisplayableDate(v.publishedAt) ? v.publishedAt : null,
    score: typeof v.score === "number" ? v.score : null,
    aiSelected: v.aiSelected === true,
  };
}

export function getStarred(): LocalStarredItem[] {
  return cached(KEYS.starred, () => {
    const raw = readRaw(KEYS.starred);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isStarredItem).map((v) => normalizeStarred(v as unknown as Record<string, unknown>)).slice(0, STARRED_LIMIT);
    } catch {
      return [];
    }
  });
}

const starredSetCache = { items: null as LocalStarredItem[] | null, ids: new Set<string>() };
export function isStarred(id: string): boolean {
  const items = getStarred();
  if (starredSetCache.items !== items) {
    starredSetCache.items = items;
    starredSetCache.ids = new Set(items.map((item) => item.id));
  }
  return starredSetCache.ids.has(id);
}

export function toggleStar(item: Omit<LocalStarredItem, "savedAt">): Promise<boolean> {
  return editLocalData(() => {
    if (starredUnreadable()) return false;
    const list = getStarred();
    const exists = list.some((s) => s.id === item.id);
    const next = exists ? list.filter((s) => s.id !== item.id) : [{ ...item, savedAt: new Date().toISOString() }, ...list].slice(0, STARRED_LIMIT);
    const saved = writeRaw(KEYS.starred, JSON.stringify(next));
    invalidate(KEYS.starred);
    return saved && !exists;
  });
}

export function removeStar(id: string) {
  return editLocalData(() => {
    if (starredUnreadable()) return;
    writeRaw(KEYS.starred, JSON.stringify(getStarred().filter((s) => s.id !== id)));
    invalidate(KEYS.starred);
  });
}
// --- read items (LRU, newest first) ---
export function getReadIds(): string[] {
  return cached(KEYS.read, () => {
    const raw = readRaw(KEYS.read);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && ID_PATTERN.test(v)).slice(0, READ_LIMIT) : [];
    } catch {
      return [];
    }
  });
}

const readSetCache = { ids: null as string[] | null, set: new Set<string>() };
export function getReadSet(): Set<string> {
  const ids = getReadIds();
  if (readSetCache.ids !== ids) {
    readSetCache.ids = ids;
    readSetCache.set = new Set(ids);
  }
  return readSetCache.set;
}

export function markRead(id: string) {
  return editLocalData(() => {
    if (!ID_PATTERN.test(id)) return;
    const ids = getReadIds();
    if (ids[0] === id) return;
    const next = [id, ...ids.filter((v) => v !== id)].slice(0, READ_LIMIT);
    writeRaw(KEYS.read, JSON.stringify(next));
    invalidate(KEYS.read);
  });
}
// --- theme ---
export type ThemePreference = "light" | "dark" | null;

export function getThemePreference(): ThemePreference {
  const v = readRaw(KEYS.theme);
  if (v === "light" || v === "dark") return v;
  // Tolerate a JSON-quoted value written by other code paths.
  if (v === '"light"' || v === '"dark"') return JSON.parse(v);
  return null;
}

export function setThemePreference(pref: ThemePreference) {
  writeRaw(KEYS.theme, pref);
  invalidate(KEYS.theme);
}

export function resolvedTheme(pref: ThemePreference = getThemePreference()): "light" | "dark" {
  if (pref) return pref;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Inline script run before paint so the first frame already has the reader's theme. */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${KEYS.theme}');if(t==='"light"'||t==='"dark"')t=JSON.parse(t);if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)}catch(e){document.documentElement.setAttribute('data-theme','light')}})();`;

// --- changelog red dot ---
export function getChangelogSeen(): string | null {
  const v = readRaw(KEYS.changelogSeen);
  return v && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? v : null;
}

export function setChangelogSeen(version: string) {
  writeRaw(KEYS.changelogSeen, version);
  invalidate(KEYS.changelogSeen);
}

// --- export / import (version 1) ---
export interface ExportBundle {
  version: 1;
  starred: LocalStarredItem[];
  read: string[];
  theme: "light" | "dark" | "auto" | null;
}

export function exportBundle(): ExportBundle {
  const pref = getThemePreference();
  return { version: 1, starred: getStarred(), read: getReadIds(), theme: pref ?? "auto" };
}

export interface ImportReport {
  starredAdded: number;
  starredSkipped: number;
  readAdded: number;
  readSkipped: number;
  themeApplied: boolean;
  /** The stars were saved but the read marks could not be (storage full or unavailable). */
  readFailed: boolean;
}

/** Merge: existing stars are not overwritten, read ids are unioned, theme only if unset. */
export async function importBundle(text: string): Promise<ImportReport> {
  if (text.length > IMPORT_MAX_CHARS) throw new Error("文件过大（上限 2,000,000 字符）");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("不是有效的 JSON 文件");
  }
  const d = data as Partial<ExportBundle>;
  if (!d || typeof d !== "object" || d.version !== 1) throw new Error("文件格式不对（需要 version: 1）");
  return mergeLocalData({
    starred: Array.isArray(d.starred) ? d.starred : [],
    read: Array.isArray(d.read) ? d.read : [],
    theme: d.theme ?? null,
  });
}

function starredUnreadable(): boolean {
  const raw = readRaw(KEYS.starred);
  if (!raw) return false;
  try {
    return !Array.isArray(JSON.parse(raw));
  } catch {
    return true;
  }
}

export function mergeLocalData(incoming: { starred: unknown[]; read: unknown[]; theme: unknown }): Promise<ImportReport> {
  return editLocalData(() => {
    // The reader's own data stays recoverable (export it, or fix it) rather than replaced by the import.
    if (starredUnreadable()) throw new Error("这台设备上已有的收藏数据无法读取，为避免覆盖，这次没有导入。");
    const current = getStarred();
    const have = new Set(current.map((s) => s.id));
    const additions: LocalStarredItem[] = [];
    let starredSkipped = 0;
    for (const s of incoming.starred) {
      if (!isStarredItem(s)) { starredSkipped++; continue; }
      if (have.has(s.id)) continue;
      have.add(s.id);
      additions.push(normalizeStarred(s as unknown as Record<string, unknown>));
    }
    const room = Math.max(0, STARRED_LIMIT - current.length);
    const accepted = additions.slice(0, room);
    starredSkipped += additions.length - accepted.length;
    const mergedStarred = [...current, ...accepted].sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
    // An import is reported only after it was written; a failure here leaves the browser as it was.
    if (!writeRaw(KEYS.starred, JSON.stringify(mergedStarred))) throw new Error("浏览器存储已满或不可用，这次没有导入任何内容。");

    const readIds = getReadIds();
    const readHave = new Set(readIds);
    const readAdditions: string[] = [];
    let readSkipped = 0;
    for (const id of incoming.read) {
      if (typeof id !== "string" || !ID_PATTERN.test(id)) { readSkipped++; continue; }
      if (readHave.has(id)) continue;
      readHave.add(id);
      readAdditions.push(id);
    }
    const readRoom = Math.max(0, READ_LIMIT - readIds.length);
    readSkipped += Math.max(0, readAdditions.length - readRoom);
    const readFailed = !writeRaw(KEYS.read, JSON.stringify([...readIds, ...readAdditions.slice(0, readRoom)]));

    let themeApplied = false;
    if (!getThemePreference() && (incoming.theme === "light" || incoming.theme === "dark")) {
      themeApplied = writeRaw(KEYS.theme, incoming.theme);
    }
    cache.clear();
    emit();
    return { starredAdded: accepted.length, starredSkipped, readAdded: readFailed ? 0 : Math.min(readAdditions.length, readRoom), readSkipped, themeApplied, readFailed };
  });
}

// --- React hooks ---
const EMPTY_STARRED: LocalStarredItem[] = [];
const EMPTY_SET = new Set<string>();

export function useStarred(): LocalStarredItem[] {
  return useSyncExternalStore(subscribeStarred, getStarred, () => EMPTY_STARRED);
}

export function useIsStarred(id: string): boolean {
  return useSyncExternalStore(subscribeStarred, () => isStarred(id), () => false);
}

export function useReadSet(): Set<string> {
  return useSyncExternalStore(subscribeRead, getReadSet, () => EMPTY_SET);
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeTheme, getThemePreference, () => null);
}

export function useChangelogSeen(): string | null {
  return useSyncExternalStore(subscribeChangelog, getChangelogSeen, () => null);
}
