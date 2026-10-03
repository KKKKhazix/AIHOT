// Issue numbers count the complete series of existing issues of a kind, while navigation keeps only
// the newest 400: the 401st daily is still 第 401 期 on its page, in the index and in v1.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ReportKind } from "@aihot/contracts/site";
import { isoWeekLabel } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { listReports, loadReport, loadReportMonth, loadReportNavigation, reportIndexRows, v1Daily } from "@aihot/backend/publication/reports";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const app = await buildApp();
const kinds: ReportKind[] = ["daily", "weekly", "monthly"];
const baseline = { daily: 0, weekly: 0, monthly: 0 };
let year: number;
let daily: string[];
let weekly: string[];
let monthly: string[];
const day = (offset: number) => new Date(Date.UTC(year, 0, 4 + offset)).toISOString().slice(0, 10);

async function insert(kind: ReportKind, keys: string[]) {
  const citation = { title: `测试条目 ${T}`, summary: `DETAIL_ONLY_${T}` };
  const content = { fixtureTag: T, overview: `DETAIL_ONLY_${T}`, ...(kind === "daily" ? { sections: [{ label: "测试", items: [citation] }] } : { themes: [{ heading: "测试", storyRefs: [citation] }] }) };
  await sql`INSERT INTO reports ${sql(keys.map((key) => ({
    kind, key, window_start: new Date("2026-01-01T00:00:00Z"), window_end: new Date("2026-01-02T00:00:00Z"),
    generated_at: new Date("2026-01-02T00:00:00Z"), origin: "manual", content: sql.json(content),
  })))}`;
}

async function get(path: string) {
  const result = await app.inject({ method: "GET", url: path });
  return { status: result.statusCode, body: result.json() };
}

before(async () => {
  const rows = await sql<{ kind: ReportKind; n: number; max_year: number }[]>`
    SELECT kind, count(*)::int AS n, max(left(key, 4)::int) AS max_year FROM reports GROUP BY kind`;
  year = Math.max(2030, ...rows.map((r) => r.max_year + 2));
  for (const row of rows) baseline[row.kind] = row.n;
  daily = Array.from({ length: 407 }, (_, i) => day(i * 2));
  weekly = Array.from({ length: 401 }, (_, i) => isoWeekLabel(day(i * 7)));
  monthly = [`${year}-01`, `${year}-03`, `${year + 1}-01`];
});
after(async () => {
  await sql`DELETE FROM reports WHERE content->>'fixtureTag' = ${T}`;
  await app.close();
  await closeDb();
});

test("complete-series ordinals cross the navigation boundary without changing report identity", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const refresh = () => t.mock.timers.tick(600_001);

  await t.test("empty series retain null latest and missing/invalid details remain 404", async () => {
    for (const kind of kinds) {
      const result = await get(`/api/site/reports/${kind}/latest-page`);
      assert.equal(result.status, 200);
      if (baseline[kind] === 0) assert.deepEqual(result.body, { index: [], report: null });
      else assert.equal(result.body.index.length, Math.min(400, baseline[kind]));
      assert.equal((await get(`/api/site/reports/${kind}/not-a-key`)).status, 404);
      assert.equal((await get(`/api/site/reports/${kind}/9999-99-99`)).status, 404);
    }
  });

  await insert("daily", daily.slice(0, 405));
  refresh();
  await t.test("405 real daily reports keep complete-series numbers while navigation stays at 400", async () => {
    const index = await listReports("daily");
    assert.equal(index.length, 400);
    assert.equal(index[0]!.key, daily[404]);
    assert.equal(index[0]!.issueNumber, baseline.daily + 405, "the 405th issue must not be numbered from a truncated 400-entry window");
    for (const n of [1, 100, 399, 405]) {
      const report = await loadReport("daily", daily[n - 1]!);
      assert.equal(report!.issueNumber, baseline.daily + n);
      assert.equal(typeof report!.issueNumber, "number");
      assert.ok(Number.isInteger(report!.issueNumber) && report!.issueNumber > 0);
    }
    assert.ok(!index.some((entry) => entry.key === daily[0]), "the first detail really is outside the navigation window");
    const raw = await reportIndexRows("daily", 400);
    assert.doesNotMatch(JSON.stringify(raw), /DETAIL_ONLY_/, "index metadata must not gain full report prose");
  });

  await t.test("index, detail, navigation, latest-page and month projections retain the same number", async () => {
    const key = daily[404]!;
    const expected = baseline.daily + 405;
    const index = await get("/api/site/reports/daily");
    const detail = await get(`/api/site/reports/daily/${key}`);
    const navigation = await get(`/api/site/reports/daily/navigation/${key}`);
    const latest = await get("/api/site/reports/daily/latest-page");
    const month = await get(`/api/site/reports/daily/months/${key.slice(0, 7)}`);
    for (const result of [index, detail, navigation, latest, month]) assert.equal(result.status, 200);
    for (const entry of [index.body.items[0], detail.body, navigation.body.items[0], latest.body.report, latest.body.index[0], month.body.items[0]]) {
      assert.equal(entry.key, key);
      assert.equal(entry.issueNumber, expected);
    }
    assert.equal(navigation.body.items.length, 400);
    assert.ok(navigation.body.items.some((entry: { title?: string }) => entry.title === undefined), "closed-month narrow navigation remains narrow");
    assert.equal((await loadReportNavigation("daily", key))[0]!.issueNumber, expected);
    assert.equal((await loadReportMonth("daily", key.slice(0, 7)))[0]!.issueNumber, expected);
    assert.ok(!("issueNumber" in (await v1Daily(key))!.report), "the v1 report contract is unchanged");
  });

  await t.test("later appends preserve old numbers within cached and refreshed snapshots", async () => {
    const oldNumbers = await Promise.all([1, 100, 399].map(async (n) => (await loadReport("daily", daily[n - 1]!))!.issueNumber));
    const warm = await listReports("daily");
    await insert("daily", daily.slice(405));
    const cached = await listReports("daily");
    assert.deepEqual(cached, warm, "the existing fresh-cache window is preserved");
    assert.equal((await loadReport("daily", daily[406]!))!.issueNumber, baseline.daily + 407);
    refresh();
    const updated = await listReports("daily");
    assert.equal(updated.length, 400);
    assert.equal(updated[0]!.issueNumber, baseline.daily + 407);
    assert.deepEqual(await Promise.all([1, 100, 399].map(async (n) => (await loadReport("daily", daily[n - 1]!))!.issueNumber)), oldNumbers);
    const key = daily[99]!;
    await sql`UPDATE reports SET revision = revision + 1 WHERE kind = 'daily' AND key = ${key}`;
    assert.equal((await loadReport("daily", key))!.issueNumber, baseline.daily + 100, "a revision does not allocate another issue");
  });

  await t.test("weekly 400 to 401 and sparse monthly issues count independently of dailies", async () => {
    await insert("weekly", weekly.slice(0, 400));
    await insert("monthly", monthly.slice(0, 1));
    refresh();
    assert.equal((await listReports("weekly"))[0]!.issueNumber, baseline.weekly + 400);
    assert.equal((await loadReport("monthly", monthly[0]!))!.issueNumber, baseline.monthly + 1);
    await insert("weekly", weekly.slice(400));
    await insert("monthly", monthly.slice(1));
    refresh();
    assert.equal((await listReports("weekly")).length, 400);
    assert.equal((await listReports("weekly"))[0]!.issueNumber, baseline.weekly + 401);
    assert.equal((await loadReport("weekly", weekly[0]!))!.issueNumber, baseline.weekly + 1);
    for (let i = 0; i < monthly.length; i += 1) assert.equal((await loadReport("monthly", monthly[i]!))!.issueNumber, baseline.monthly + i + 1);
    const crossing = weekly.findIndex((key, i) => i > 0 && key.slice(0, 4) !== weekly[i - 1]!.slice(0, 4));
    assert.ok(crossing > 0);
    assert.equal((await loadReport("weekly", weekly[crossing]!))!.issueNumber, baseline.weekly + crossing + 1);
  });

  await t.test("earlier backfill and deletion intentionally adjust chronological positions", async () => {
    const earlier = day(-2);
    const key = daily[99]!;
    const before = (await loadReport("daily", key))!.issueNumber;
    await insert("daily", [earlier]);
    assert.equal((await loadReport("daily", key))!.issueNumber, before + 1);
    refresh();
    assert.equal((await listReports("daily")).find((entry) => entry.key === key)!.issueNumber, before + 1);
    await sql`DELETE FROM reports WHERE kind = 'daily' AND key = ${earlier} AND content->>'fixtureTag' = ${T}`;
    assert.equal((await loadReport("daily", key))!.issueNumber, before);
    refresh();
    assert.equal((await listReports("daily")).find((entry) => entry.key === key)!.issueNumber, before);
  });
});
