// Run after `npm run build -w @aihot/web`. Real production server/router, synthetic HTTP API only.
// Failure cases: the masthead numbering the newest of 405 issues 400 (the navigation index's length); an
// issue older than the index losing its number; the calendar marking that issue as not published; the
// daily archive counting 400 issues beside a masthead that numbers 405.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ReportDetail, ReportKind, ReportNavigationEntry } from "@aihot/contracts/site";
import { isoWeekLabel } from "@aihot/contracts/time";
import { chipLabel, issueNumber, neighbourLabel, periodGrid } from "../app/features/report/format.ts";
import { fakeApi, startWebServer, type WebServer } from "./web-server.ts";

const kinds: ReportKind[] = ["daily", "weekly", "monthly"];
const keys = Object.fromEntries(kinds.map((kind) => [kind, Array.from({ length: 405 }, (_, i) => {
  if (kind === "monthly") return new Date(Date.UTC(2020, i, 1)).toISOString().slice(0, 7);
  const day = new Date(Date.UTC(2020, 0, 6 + i * (kind === "weekly" ? 7 : 1))).toISOString().slice(0, 10);
  return kind === "weekly" ? isoWeekLabel(day) : day;
})])) as Record<ReportKind, string[]>;
/** The navigation as the api sends it: the newest 400 issues, each with its number in the whole series. */
const index = (kind: ReportKind): ReportNavigationEntry[] => keys[kind].map((key, i) => ({ key, issueNumber: i + 1, title: `第${i + 1}期` })).reverse().slice(0, 400);
function report(kind: ReportKind, key: string): ReportDetail {
  return {
    kind, key, issueNumber: keys[kind].indexOf(key) + 1, title: "测试刊物", generatedAt: "2020-01-02T00:00:00Z",
    lead: null, leadItemId: null, overview: null, highlights: [], sections: [], flashes: [], cover: null, metrics: {}, readingMinutes: 1, prev: null, next: null,
  };
}
let web: WebServer;
const api = fakeApi((url) => {
  const path = url.pathname;
  if (path === "/api/site/reports/daily") return { kind: "daily", items: index("daily").map((entry) => ({ ...entry, count: 1 })) };
  const match = /^\/api\/site\/reports\/(daily|weekly|monthly)\/(.+)$/.exec(path);
  if (match) {
    const kind = match[1] as ReportKind;
    const key = match[2]!;
    if (key === "latest-page") return { index: index(kind), report: report(kind, keys[kind].at(-1)!) };
    if (key.startsWith("navigation/")) return { items: index(kind) };
    if (keys[kind].includes(key)) return report(kind, key);
  }
});

before(async () => { web = await startWebServer(api); });
after(() => web.stop());

/** The masthead's visible text (the archive's has the same frame). */
function masthead(html: string): string {
  const header = /<header class="pt-5 lg:pt-0">([\s\S]*?)<\/header>/.exec(html);
  assert.ok(header, "the report masthead is rendered");
  return header[1]!.replace(/<[^>]+>/g, "");
}

for (const kind of kinds) {
  test(`the ${kind} masthead numbers the newest of 405 issues 405, not the navigation's 400`, async () => {
    const response = await fetch(`${web.origin}/${kind}`);
    assert.equal(response.status, 200, web.logs());
    const visible = masthead(await response.text());
    assert.match(visible, /第\s*405\s*期/);
    assert.doesNotMatch(visible, /第\s*400\s*期/);
  });

  test(`the oldest ${kind} issue, outside the navigation, keeps its number`, async () => {
    const first = keys[kind][0]!;
    assert.ok(!index(kind).some((entry) => entry.key === first));
    const response = await fetch(`${web.origin}/${kind}/${first}`);
    assert.equal(response.status, 200, web.logs());
    assert.match(masthead(await response.text()), /第\s*1\s*期/);
  });

  test(`the ${kind} calendar labels this issue with its own number and makes up none for others`, () => {
    const first = keys[kind][0]!;
    const { cells } = periodGrid(kind, first, index(kind), 1);
    const current = cells.find((cell) => cell.key === first)!;
    assert.equal(current.state, "current");
    assert.match(current.label, /第 1 期/);
    const unlisted = cells.find((cell) => cell.key === keys[kind][1])!;
    assert.doesNotMatch(unlisted.label, /第 \d+ 期/, "an issue the navigation does not list gets no number");
    assert.equal(issueNumber(index(kind), keys[kind].at(-1)!), 405);
    const stale = periodGrid(kind, first, [{ key: first, issueNumber: 9 }], 10);
    assert.match(stale.cells.find((cell) => cell.key === first)!.label, /第 10 期/, "the report's own number wins over an older navigation");
  });
}

test("the daily archive counts every issue, as the masthead numbers them", async () => {
  const response = await fetch(`${web.origin}/daily/archive`);
  assert.equal(response.status, 200, web.logs());
  assert.match(masthead(await response.text()), /共\s*405\s*期/);
});

// On 2 January 2027 the chip for the 31 December issue read "12月31日" and the 1 January issue's "前一日"
// link "前一日 · 12月31日": both read as 2027's (KKKKhazix/AIHOT#274).
test("a day of another Beijing year carries its year in the phone chip and the prev/next links", () => {
  const days = [{ key: "2026-12-31", issueNumber: 400, title: "第400期" }, { key: "2027-01-01", issueNumber: 401, title: "第401期" }];
  assert.equal(chipLabel("daily", "2027-01-02", days, "2027-01-02"), "今天");
  assert.equal(chipLabel("daily", "2027-01-01", days, "2027-01-02"), "1月1日");
  assert.equal(chipLabel("daily", "2026-12-31", days, "2027-01-02"), "2026年12月31日");
  const endOfYear = Date.parse("2026-12-31T23:30:00+08:00");
  assert.equal(neighbourLabel("daily", "2026-12-30", "prev", endOfYear), "前一日 · 12月30日");
  assert.equal(neighbourLabel("daily", "2027-01-01", "prev", endOfYear), "前一日 · 2027年1月1日");
  const newYear = Date.parse("2027-01-01T08:00:00+08:00");
  assert.equal(neighbourLabel("daily", "2026-12-31", "prev", newYear), "前一日 · 2026年12月31日");
  assert.equal(neighbourLabel("daily", "2027-01-02", "next", newYear), "后一日 · 1月2日");
});
