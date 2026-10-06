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

test("English wall-clock dates are not shifted by the host's daylight-saving gap", () => {
  const zone = process.env.TZ;
  try {
    for (const tz of ["UTC", "Asia/Shanghai", "America/New_York", "Europe/Berlin"]) {
      process.env.TZ = tz;
      assert.equal(iso("Mar 8, 2026 02:30", "+00:00"), "2026-03-08T02:30:00.000Z", tz);
      assert.equal(iso("8 March 2026 02:30:45", "+08:00"), "2026-03-07T18:30:45.000Z", tz);
      assert.equal(iso("March 29th, 2026 02:30", "+00:00"), "2026-03-29T02:30:00.000Z", tz);
      assert.equal(iso("29 Mar 2026 02:30", "-07:00"), "2026-03-29T09:30:00.000Z", tz);
      assert.equal(iso("Sep 26, 2026 10:00 PM"), "2026-09-26T14:00:00.000Z", tz);
      assert.equal(iso("Sep 26, 2026"), "2026-09-25T16:00:00.000Z", tz);
      assert.equal(iso("Feb 30, 2026 02:30", "+00:00"), null, tz);
      assert.equal(iso("Mar 8, 2026 25:30", "+00:00"), null, tz);
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("English times with explicit zones retain their zone on every host", () => {
  const zone = process.env.TZ;
  try {
    for (const tz of ["UTC", "Asia/Shanghai", "America/New_York", "Europe/Berlin"]) {
      process.env.TZ = tz;
      for (const [time, expected] of [
        ["Mar 8, 2026 02:30 GMT", "2026-03-08T02:30:00.000Z"],
        ["8 Mar 2026 02:30 +0200", "2026-03-08T00:30:00.000Z"],
        ["Mar 8, 2026 02:30 EST", "2026-03-08T07:30:00.000Z"],
        ["Mar 8, 2026 10:30 PM PDT", "2026-03-09T05:30:00.000Z"],
        ["March 8th, 2026 02:30 +0200", "2026-03-08T00:30:00.000Z"],
        ["Mar 8, 2026 25:30 GMT", null],
      ]) assert.equal(iso(time!, "+08:00"), expected, `${tz}: ${time}`);
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});

test("CST, which Chinese pages print for China time, is read in the source's offset", () => {
  assert.equal(iso("2026-09-26 10:00:00 CST"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("Sep 26, 2026 10:00 PM CST"), "2026-09-26T14:00:00.000Z");
  assert.equal(iso("2026-09-26 10:00 CST", "-06:00"), "2026-09-26T16:00:00.000Z");
});

test("an article page's publication time without a zone is the same moment across host zones", () => {
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
    for (const tz of ["America/New_York", "Europe/Berlin"]) {
      assert.equal(read(tz, "Mar 8, 2026 02:30", "+00:00"), "2026-03-08T02:30:00.000Z", tz);
      assert.equal(read(tz, "Mar 29, 2026 02:30", "+00:00"), "2026-03-29T02:30:00.000Z", tz);
    }
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
