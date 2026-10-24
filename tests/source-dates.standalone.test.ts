// Published dates as list pages, article pages and JSON lists print them: a date without a zone is read
// in the source's offset, whatever zone the server runs in (Docker runs in UTC; run this file with TZ=UTC
// and TZ=Asia/Shanghai to see both).
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeReport } from "@aihot/backend/events/relate";
import { readable } from "@aihot/backend/content/extract";
import { parseLooseDate, readPublicationDate, readRelativeDate, describePublicationTime } from "@aihot/backend/sources/dates";

const iso = (v: string, offset?: string) => parseLooseDate(v, offset)?.toISOString() ?? null;

test("a date and time without a zone is in the source's offset, not the server's", () => {
  assert.equal(iso("2026-09-26 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026-09-26T10:00:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026/09/26 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026年9月26日 10:00"), "2026-09-26T02:00:00.000Z");
  assert.equal(iso("2026-09-26 10:00", "-07:00"), "2026-09-26T17:00:00.000Z");
});

test("a bare date is midnight in the source's offset, including ISO date-only text", () => {
  assert.equal(iso("2026/09/26"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("2026年9月26日"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("Sep 26, 2026"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("2026-09-26"), "2026-09-25T16:00:00.000Z");
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

test('"at" between the date and the time joins them like a space', () => {
  assert.equal(iso("Sep 26, 2026 at 10:30"), "2026-09-26T02:30:00.000Z");
  assert.equal(iso("Published Sep 26, 2026 at 10:30 AM"), "2026-09-26T02:30:00.000Z");
  assert.equal(iso("September 26, 2026 at 10:30 AM EST"), "2026-09-26T15:30:00.000Z");
  assert.equal(iso("March 8, 2026 at 02:30", "+00:00"), "2026-03-08T02:30:00.000Z");
  assert.equal(iso("2026-09-26 at 10:30"), "2026-09-26T02:30:00.000Z");
  assert.equal(iso("09/26/2026 at 10:30"), "2026-09-26T02:30:00.000Z");
  assert.deepEqual(readPublicationDate("2026-09-26 at 10:30").publicationTime, "2026-09-26T02:30:00.000Z");
});

test("an abbreviated month may end with a period", () => {
  assert.equal(iso("Sept. 26, 2026"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("Published Sept. 26, 2026"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("26 Sept. 2026"), "2026-09-25T16:00:00.000Z");
  assert.equal(iso("Sept. 26, 2026, 10:30 AM EDT"), "2026-09-26T14:30:00.000Z");
  assert.equal(iso("Feb. 30, 2026"), null);
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
    return readable(page(time), "https://example.org/post", { utcOffset: offset })?.publishedAt?.toISOString() ?? null;
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

// An article page's own publication time is one reading for collection and extraction: its named
// metadata in order, never a modification time, a related article's date in embedded app state, or the
// update time some pages put in their structured data when they also name the original publication.
test("an article page's publication metadata is read one way, original publication first", () => {
  const prose = `<p>${"The model is available to every developer from today, at the same price as before. ".repeat(4)}</p>`;
  const page = (head: string, body = "") => `<html><head>${head}</head><body><article><h1>Release</h1>${prose}${body}</article></body></html>`;
  const read = (html: string) => readable(html, "https://example.org/post", { utcOffset: "+00:00" })?.publishedAt?.toISOString() ?? null;
  const ld = (date: string) => `<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","datePublished":"${date}"}</script>`;
  assert.equal(read(page(`<meta property="article:published_time" content="2026-09-23T19:22:24Z">${ld("2026-10-12T16:12:26Z")}`)), "2026-09-23T19:22:24.000Z");
  assert.equal(read(page(`<meta name="pubdate" content="2026-10-14">${ld("2026-10-14T19:30:21Z")}`)), "2026-10-14T19:30:21.000Z", "a date gives way to its time on the same day");
  assert.equal(read(page(`<meta name="pubdate" content="2026-10-14">${ld("2026-10-16T08:00:00Z")}`)), "2026-10-14T00:00:00.000Z", "not to another day");
  assert.equal(read(page(`<meta property="article:modified_time" content="2026-10-14T00:00:00Z">`, `<script>window.__STATE__={"related":[{"datePublished":"2020-01-01T00:00:00Z"}]}</script>`)), null);
});

test('all date-only formats retain the source calendar day and use its offset', () => {
  for (const value of ['2026-10-13', '2026/10/13', 'October 13, 2026', '13 October 2026']) {
    assert.equal(parseLooseDate(value, '-07:00')?.toISOString(), '2026-10-13T07:00:00.000Z', value);
    assert.deepEqual(readPublicationDate(value, '-07:00'), { publishedAt: new Date('2026-10-13T07:00:00Z'), publicationTime: '2026-10-13' });
  }
});

test('real midnight keeps its precision; date-only and missing source precision never invent it', () => {
  assert.deepEqual(readPublicationDate('2026-10-13T00:00:00-07:00'), { publishedAt: new Date('2026-10-13T07:00:00Z'), publicationTime: '2026-10-13T07:00:00.000Z' });
  assert.equal(describePublicationTime(new Date('2026-10-13T07:00:00Z'), '2026-10-13'), '2026-10-13（原文仅有日期，时刻未知）');
  assert.equal(describePublicationTime(new Date('2026-10-13T07:00:00Z'), null), '2026-10-13 15:00（历史记录，原始精度未知）');
  assert.equal(describePublicationTime(null, null), '未知');
});

test('grouping distinguishes a publication day from an exact instant', () => {
  const report = { title: 'Release', source: 'Official', firstParty: true, at: new Date('2026-10-13T07:00:00Z'), publicationTime: '2026-10-13', summary: null };
  const text = describeReport(report, '报道');
  assert.match(text, /发布时间：2026-10-13（原文仅有日期，时刻未知）/);
  assert.doesNotMatch(text, /15:00/);
});

test("legacy JSON and RSS formats keep their source date and zone", () => {
  for (const tz of ["UTC", "Asia/Shanghai", "America/New_York"]) {
    const previous = process.env.TZ;
    process.env.TZ = tz;
    try {
      assert.equal(iso("10/18/2026 10:00 PM", "+00:00"), "2026-10-18T22:00:00.000Z");
      assert.equal(iso("10/18/2026 12:00 AM", "+00:00"), "2026-10-18T00:00:00.000Z");
      assert.equal(iso("10/18/2026 12:00 PM", "+00:00"), "2026-10-18T12:00:00.000Z");
      assert.equal(iso("10/18/2026 13:00 PM", "+00:00"), null);
      assert.deepEqual(readPublicationDate("10/18/2026", "-07:00"), { publishedAt: new Date("2026-10-18T07:00:00Z"), publicationTime: "2026-10-18" });
      assert.deepEqual(readPublicationDate("Sun, 18 Oct 26 10:00:00 GMT"), { publishedAt: new Date("2026-10-18T10:00:00Z"), publicationTime: "2026-10-18T10:00:00.000Z" });
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  }
});

test("a date rule's element that prints an age counts back from the moment it is read", () => {
  const now = new Date("2026-10-24T01:30:00.000Z"); // 09:30 in +08:00
  assert.deepEqual(readRelativeDate("20小时前", now), { publishedAt: new Date("2026-10-23T05:30:00.000Z"), publicationTime: "2026-10-23T05:30:00.000Z" });
  assert.deepEqual(readRelativeDate(" 15 分钟前 ", now), { publishedAt: new Date("2026-10-24T01:15:00.000Z"), publicationTime: "2026-10-24T01:15:00.000Z" });
  assert.deepEqual(readRelativeDate("3 hours ago", now, "+00:00"), { publishedAt: new Date("2026-10-23T22:30:00.000Z"), publicationTime: "2026-10-23T22:30:00.000Z" });
  // More than a day of hours is still hours: its time is kept, not cut to a calendar day.
  assert.deepEqual(readRelativeDate("47小时前", now), { publishedAt: new Date("2026-10-22T02:30:00.000Z"), publicationTime: "2026-10-22T02:30:00.000Z" });
  // Days keep the calendar day in the source's offset.
  assert.deepEqual(readRelativeDate("2天前", now), { publishedAt: new Date("2026-10-21T16:00:00.000Z"), publicationTime: "2026-10-22" });
  assert.deepEqual(readRelativeDate("昨天", now), { publishedAt: new Date("2026-10-22T16:00:00.000Z"), publicationTime: "2026-10-23" });
  // 22:30 on the 23rd in -03:00, a day back is the 22nd there.
  assert.deepEqual(readRelativeDate("1 day ago", now, "-03:00"), { publishedAt: new Date("2026-10-22T03:00:00.000Z"), publicationTime: "2026-10-22" });
});

test("an age inside other text is no date", () => {
  const now = new Date("2026-10-24T01:30:00.000Z");
  for (const v of ["两天前开业的店", "大约2天前", "2天前 1.1万", "", null]) assert.deepEqual(readRelativeDate(v, now), { publishedAt: null, publicationTime: null });
});

test("a date rule's element that prints today's or a recent day's time reads it on that day in the source's offset", () => {
  const now = new Date("2026-10-24T10:30:00.000Z"); // 18:30 in +08:00
  const at = (iso: string) => ({ publishedAt: new Date(iso), publicationTime: new Date(iso).toISOString() });
  assert.deepEqual(readRelativeDate("今天 15:46", now), at("2026-10-24T07:46:00Z"));
  assert.deepEqual(readRelativeDate("今天08:29", now), at("2026-10-24T00:29:00Z"));
  assert.deepEqual(readRelativeDate("昨天 23:10", now), at("2026-10-23T15:10:00Z"));
  assert.deepEqual(readRelativeDate("前天 08:05", now), at("2026-10-22T00:05:00Z"));
  // 01:30Z is 09:30 on the 24th in +08:00 but 22:30 on the 23rd in -03:00: "今天" is the source's day.
  assert.deepEqual(readRelativeDate("今天 21:00", new Date("2026-10-24T01:30:00.000Z"), "-03:00"), at("2026-10-24T00:00:00Z"));
});

test("a byline ahead of the date in the same element is no part of it", () => {
  const now = new Date("2026-10-24T10:30:00.000Z");
  // 创业邦 prints its author and the age in one element: "版面之外·今天 15:46", "创业邦的创作者·48分钟前".
  assert.deepEqual(readRelativeDate("版面之外·今天 15:46", now), readRelativeDate("今天 15:46", now));
  assert.deepEqual(readRelativeDate("创业邦的创作者·48分钟前", now), { publishedAt: new Date("2026-10-24T09:42:00Z"), publicationTime: "2026-10-24T09:42:00.000Z" });
  assert.deepEqual(readRelativeDate("20社 · 昨天 09:00", now), readRelativeDate("昨天 09:00", now));
});

test("an age in short English units reads like the long ones", () => {
  const now = new Date("2026-10-24T10:30:00.000Z");
  // DealStreetAsia and TNW listings: "16h ago", "29m ago".
  assert.deepEqual(readRelativeDate("16h ago", now, "+00:00"), { publishedAt: new Date("2026-10-23T18:30:00Z"), publicationTime: "2026-10-23T18:30:00.000Z" });
  assert.deepEqual(readRelativeDate("29m ago", now, "+00:00"), { publishedAt: new Date("2026-10-24T10:01:00Z"), publicationTime: "2026-10-24T10:01:00.000Z" });
  assert.deepEqual(readRelativeDate("2d ago", now, "+00:00"), { publishedAt: new Date("2026-10-22T00:00:00Z"), publicationTime: "2026-10-22" });
});

test("today's time inside other text, or no real time, is no date", () => {
  const now = new Date("2026-10-24T10:30:00.000Z");
  for (const v of ["据说今天 15:46 发布", "今天 25:00", "今天 15:61", "版面之外·今天 15:46 1.1万", "关于·两天前开业的店", "甲·乙·今天 15:46", "·今天 15:46", "16h", "29 m ago later"]) {
    assert.deepEqual(readRelativeDate(v, now), { publishedAt: null, publicationTime: null }, v);
  }
});
