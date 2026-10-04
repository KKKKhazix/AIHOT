// Published dates as list pages, article pages and JSON lists print them: a date without a zone is read
// in the source's offset, whatever zone the server runs in (Docker runs in UTC; run this file with TZ=UTC
// and TZ=Asia/Shanghai to see both).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readable } from "@aihot/backend/content/extract";
import { parseLooseDate } from "@aihot/backend/sources/dates";

const iso = (v: string, offset?: string) => parseLooseDate(v, offset)?.toISOString() ?? null;

test("a date and time without a zone is in the source's offset, not the server's", () => {
  assert.equal(iso("2026-09-26 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026-09-26T10:00:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026/09/26 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026年9月26日 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026-09-26 10:00", "-07:00"), "2026-09-26T17:00:00.000Z");
});

test("a bare date is midnight in the source's offset; an ISO date alone stays UTC midnight", () => {
  assert.equal(iso("2026/09/26"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("2026年9月26日"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("Sep 26, 2026"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("2026-09-26"), "2026-09-26T00:00:00.000Z");
  assert.equal(iso("September 26th, 2026", "+00:00"), "2026-09-26T00:00:00.000Z");
});

test("a date that carries its zone keeps it", () => {
  assert.equal(iso("2026-09-26T10:00:00Z"), "2026-09-26T10:00:00.000Z");
  assert.equal(iso("2026-09-26T10:00:00.000+09:00"), "2026-09-26T01:00:00.000Z");
  assert.equal(iso("Sat, 26 Sep 2026 10:00:00 GMT"), "2026-09-26T10:00:00.000Z");
  assert.equal(iso("Sat, 26 Sep 2026 10:00:00 +0200", "-07:00"), "2026-09-26T08:00:00.000Z");
});

test("no date at all is null", () => {
  assert.equal(iso(""), null);
  assert.equal(iso("yesterday"), null);
});

test("an article page's publication time without a zone is the same moment on a UTC and a Shanghai server", () => {
  const page = (time: string) => `<html><head><meta property="article:published_time" content="${time}"></head><body><article><h1>Release</h1><p>${"The model is available to every developer from today, at the same price as before. ".repeat(4)}</p></article></body></html>`;
  const zone = process.env.TZ;
  const read = (tz: string, time: string, offset?: string) => {
    process.env.TZ = tz;
    return readable(page(time), "https://example.org/post", offset)?.publishedAt?.toISOString() ?? null;
  };
  try {
    for (const tz of ["UTC", "Asia/Shanghai"]) {
      assert.equal(read(tz, "2026-09-26T10:00:00"), "2026-09-26T02:00:00.000Z", tz);
      assert.equal(read(tz, "2026-09-26T10:00:00", "+00:00"), "2026-09-26T10:00:00.000Z", tz);
      assert.equal(read(tz, "2026-09-26T10:00:00+09:00", "+00:00"), "2026-09-26T01:00:00.000Z", tz);
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
