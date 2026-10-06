// An onboarding boundary must remain an exact instant on every host; malformed or rounded-over
// dates must be refused before a source could accidentally collect and analyse its whole archive.
import assert from "node:assert/strict";
import { test } from "node:test";
import { unsupportedConfig } from "@aihot/backend/sources/config-keys";

test("ordinary listing sources accept an exact UTC publication boundary", () => {
  for (const kind of ["rss", "web_list", "json_list"] as const) {
    for (const publishedAfter of ["2026-09-28T00:00:00.000Z", "2026-09-28T00:00:00Z", "2024-02-29T23:59:59.999Z"]) {
      assert.deepEqual(unsupportedConfig(kind, { publishedAfter }), []);
    }
  }
});

test("a publication boundary rejects missing zones, incomplete and impossible dates, and non-string values", () => {
  for (const publishedAfter of ["2026-09-28", "2026-09-28T00:00:00", "September 28, 2026", "2026-02-30T00:00:00Z", "2026-09-28T24:00:00Z", "2026-13-01T00:00:00Z", "", null, 1790553600000]) {
    assert.deepEqual(unsupportedConfig("web_list", { publishedAfter }), ["publishedAfter"], String(publishedAfter));
  }
});

test("channels that do not apply the publication boundary refuse it instead of ignoring it", () => {
  for (const kind of ["x_search", "mp_account", "external"] as const) {
    assert.deepEqual(unsupportedConfig(kind, { publishedAfter: "2026-09-28T00:00:00Z" }), ["publishedAfter"]);
  }
});
