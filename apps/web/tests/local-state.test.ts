import assert from "node:assert/strict";
import { after, test } from "node:test";
import { beijingDate, beijingTime } from "@aihot/contracts/time";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
after(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

let instance = 0;
async function reader(stars: unknown[] = []) {
  const values = new Map<string, string>([["aihot-starred-items", JSON.stringify(stars)]]);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } },
  });
  // A fresh module has the same empty snapshot cache as a newly opened browser tab.
  const state: typeof import("../app/lib/local-state.ts") = await import(`../app/lib/local-state.ts?test=${instance++}`);
  return { state, values };
}

const invalidDates = ["not-a-date", "", "999999-01-01", "+275760-09-13T00:00:00.000Z", null, 42, {}];
const displayDate = (value: string) => `${beijingDate(value)} ${beijingTime(value)}`;

test("import normalizes invalid bookmark dates before persisting without dropping bookmarks", async () => {
  const { state, values } = await reader();
  const before = Date.now();
  const result = state.importBundle(JSON.stringify({ version: 1, starred: invalidDates.map((value, i) => ({
    id: `item-${i}`, title: `Title ${i}`, savedAt: value, publishedAt: value,
  })) }));
  assert.equal(result.starredAdded, invalidDates.length);
  const saved = JSON.parse(values.get(state.KEYS.starred)!);
  assert.equal(saved.length, invalidDates.length);
  for (const item of saved) {
    assert.equal(item.publishedAt, null);
    assert.ok(Date.parse(item.savedAt) >= before && Date.parse(item.savedAt) <= Date.now());
    assert.doesNotThrow(() => displayDate(item.savedAt));
  }
});

test("existing invalid dates are readable, exportable and removable after reopening the page", async () => {
  const { state } = await reader([{ id: "old", title: "Keep this bookmark", savedAt: "broken", publishedAt: "broken" }]);
  const stars = state.getStarred();
  assert.equal(stars.length, 1);
  assert.equal(stars[0]!.title, "Keep this bookmark");
  assert.equal(stars[0]!.publishedAt, null);
  assert.doesNotThrow(() => displayDate(stars[0]!.savedAt));
  assert.strictEqual(state.getStarred(), stars, "normalization preserves stable React snapshots");
  assert.deepEqual(state.exportBundle().starred, stars);
  state.removeStar("old");
  assert.deepEqual(state.getStarred(), []);
});

test("valid dates and existing bookmarks survive import unchanged", async () => {
  const item = { id: "valid", title: "Original title", savedAt: "2026-09-29T08:30:00+08:00", publishedAt: "2026-09-28T23:00:00Z" };
  const { state } = await reader([item]);
  const result = state.importBundle(JSON.stringify({ version: 1, starred: [{ ...item, title: "Replacement", savedAt: "broken" }] }));
  assert.equal(result.starredAdded, 0);
  const [saved] = state.getStarred();
  assert.equal(saved!.title, item.title);
  assert.equal(saved!.savedAt, item.savedAt);
  assert.equal(saved!.publishedAt, item.publishedAt);
});
