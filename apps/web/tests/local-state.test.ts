import assert from "node:assert/strict";
import { after, test } from "node:test";
import { runInNewContext } from "node:vm";
import { beijingDate, beijingTime } from "@aihot/contracts/time";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

let instance = 0;
async function reader(starred: unknown[] = []) {
  const values = new Map([["aihot-starred-items", JSON.stringify(starred)]]);
  const session = new Map<string, string>();
  let denied = false;
  const makeStore = (map: Map<string, string>) => ({
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { if (denied) throw new Error("full"); map.set(key, value); },
    removeItem: (key: string) => { if (denied) throw new Error("full"); map.delete(key); },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: makeStore(values), sessionStorage: makeStore(session) },
  });
  // Reopening the page starts with an empty snapshot cache.
  const state: typeof import("../app/lib/local-state.ts") = await import(`../app/lib/local-state.ts?test=${instance++}`);
  return { state, values, setDenied: (v: boolean) => { denied = v; } };
}

const displayDate = (value: string) => `${beijingDate(value)} ${beijingTime(value)}`;

test("import keeps bookmarks with invalid dates and persists displayable replacements", async () => {
  const invalid = ["broken", "", "999999-01-01", "+275760-09-13T00:00:00.000Z", null, 42, {}];
  const { state, values } = await reader();
  const before = Date.now();
  const report = state.importBundle(JSON.stringify({ version: 1, starred: invalid.map((date, i) => ({
    id: `import-${i}`, title: `Bookmark ${i}`, savedAt: date, publishedAt: date,
  })) }));
  assert.equal(report.starredAdded, invalid.length);
  const saved = JSON.parse(values.get(state.KEYS.starred)!);
  assert.equal(saved.length, invalid.length);
  for (const item of saved) {
    assert.equal(item.publishedAt, null);
    assert.ok(Date.parse(item.savedAt) >= before && Date.parse(item.savedAt) <= Date.now());
    assert.doesNotThrow(() => displayDate(item.savedAt));
  }
});

test("stored bookmarks with damaged dates remain readable, exportable and removable", async () => {
  const { state } = await reader([{ id: "stored", title: "Keep me", savedAt: "broken", publishedAt: "broken" }]);
  const starred = state.getStarred();
  assert.equal(starred.length, 1);
  assert.equal(starred[0]!.title, "Keep me");
  assert.equal(starred[0]!.publishedAt, null);
  assert.doesNotThrow(() => displayDate(starred[0]!.savedAt));
  assert.strictEqual(state.getStarred(), starred, "React snapshots must stay stable between changes");
  assert.deepEqual(state.exportBundle().starred, starred);
  state.removeStar("stored");
  assert.deepEqual(state.getStarred(), []);
});

test("valid dates are preserved and an import cannot replace an existing bookmark", async () => {
  const existing = { id: "valid", title: "Original", savedAt: "2026-09-29T08:30:00+08:00", publishedAt: "2026-09-28T23:00:00Z" };
  const { state } = await reader([existing]);
  const report = state.importBundle(JSON.stringify({ version: 1, starred: [{ ...existing, title: "Replacement", savedAt: "broken" }] }));
  assert.equal(report.starredAdded, 0);
  const [saved] = state.getStarred();
  assert.equal(saved!.title, existing.title);
  assert.equal(saved!.savedAt, existing.savedAt);
  assert.equal(saved!.publishedAt, existing.publishedAt);
});

// Failure cases before changing storage: another tab's writes must survive a cached-tab edit;
// unreadable bookmarks must not be overwritten and failed writes must not report success.
test("a cached tab merges newer saved bookmarks and read marks before writing", async () => {
  const { state, values } = await reader([{ id: "old", title: "Old" }]);
  state.getStarred();
  state.getReadIds();
  values.set(state.KEYS.starred, JSON.stringify([{ id: "other-tab", title: "Other tab" }, { id: "old", title: "Old" }]));
  values.set(state.KEYS.read, JSON.stringify(["other-tab"]));
  state.toggleStar({ id: "new", title: "New", summary: null, sourceName: "", publishedAt: null, score: null, aiSelected: false });
  state.markRead("new");
  assert.deepEqual(state.getStarred().map((s) => s.id), ["new", "other-tab", "old"]);
  assert.deepEqual(state.getReadIds(), ["new", "other-tab"]);
});

test("failed bookmark writes and damaged existing data do not report a successful toggle", async () => {
  const { state, values } = await reader();
  const item = { id: "new", title: "New", summary: null, sourceName: "", publishedAt: null, score: null, aiSelected: false };
  values.set(state.KEYS.starred, "damaged original data");
  assert.equal(state.toggleStar(item), false);
  assert.equal(values.get(state.KEYS.starred), "damaged original data");
  window.localStorage.setItem = () => { throw new Error("quota"); };
  assert.equal(state.toggleStar(item), false);
});

// Readers' browsers already keep their stars, read marks and settings under these names; a renamed key
// is an empty one for every existing reader. New keys may be added.
test("the storage keys readers already have data under keep their names", async () => {
  const { state } = await reader();
  const kept = {
    starred: "aihot-starred-items", read: "aihot-read-items", unreadOnly: "aihot-unread-only", theme: "aihot-theme", font: "aihot-font",
    changelogSeen: "aihot-changelog-seen-version", feedbackDraft: "aihot-feedback-draft-v1", recentSearches: "aihot-recent-searches",
  } as const;
  for (const [role, key] of Object.entries(kept)) {
    assert.equal(state.KEYS[role as keyof typeof kept], key, `readers' ${role} data is stored under ${key}; renaming the key loses it`);
  }
});

test("appearance startup applies a saved browser font before rendering and safely handles invalid storage", async () => {
  const { state } = await reader();
  for (const font of ["browser", "bad", null, "denied"]) {
    const attributes: Record<string, string> = {};
    runInNewContext(state.APPEARANCE_BOOT_SCRIPT, {
      localStorage: { getItem: (key: string) => { if (font === "denied") throw new Error("blocked"); return key === state.KEYS.font ? font : "dark"; } },
      window: { matchMedia: () => ({ matches: false }) },
      document: { documentElement: { setAttribute: (key: string, value: string) => { attributes[key] = value; } }, querySelectorAll: () => [] },
    });
    assert.equal(attributes["data-font"], font === "browser" ? "browser" : "system");
    assert.equal(attributes["data-theme"], font === "denied" ? "light" : "dark");
  }
});

test("font choices survive version-1 backups and denied writes without touching existing reader data", async () => {
  const { state, setDenied } = await reader();
  state.setFontPreference("browser");
  assert.equal(state.getFontPreference(), "browser");
  const backup = state.exportBundle();
  assert.equal(backup.version, 1);
  assert.equal(backup.font, "browser");
  state.setFontPreference(null);
  state.importBundle(JSON.stringify({ version: 1, starred: [], read: [], theme: "auto" }));
  assert.equal(state.getFontPreference(), null, "old backups remain valid");
  state.importBundle(JSON.stringify(backup));
  assert.equal(state.getFontPreference(), "browser");
  state.importBundle(JSON.stringify({ ...backup, font: "system" }));
  assert.equal(state.getFontPreference(), "browser", "merging does not overwrite the reader's choice");
  state.setFontPreference(null);
  setDenied(true);
  state.setFontPreference("browser");
  assert.equal(state.getFontPreference(), "browser", "a choice still works in this tab when persistence is blocked");
  state.setFontPreference(null);
  assert.equal(state.getFontPreference(), null);
  setDenied(false);
});
