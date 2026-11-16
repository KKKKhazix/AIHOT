// Failure cases: automatic runs rewrite published issues; report/receipt commits split; empty gaps
// starve later daily/weekly/monthly issues or make a failed run look successful. All use a local model stub.
import { editionAt, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { addDays } from "@aihot/contracts/time";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { composeDaily, composeDueReports, composeWeekly, composeMonthly } from "@aihot/backend/reports/compose";

const T = tag();
const SOURCE = `report-recovery-${T}`;
const answer = async (user: string) => ({ title: user.slice(0, 100), leadParagraph: "导语", highlights: [1], headline: "本期进展", overview: "总述", themes: [{ heading: "主题", summary: "摘要", refs: [1] }] });
const provider = await stub(async (_hit, request) => ({
  choices: [{ message: { content: JSON.stringify(await answer(JSON.parse(request.body).messages.at(-1).content)) } }],
}));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${SOURCE}, 'Report recovery', 'rss', 'T1')`;
});
beforeEach(async () => {
  await sql`DELETE FROM reports`;
  await sql`DELETE FROM articles WHERE source_id = ${SOURCE}`;
});
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

/** A selected item in the window of the daily issue dated `date`, half a day before its edition time. */
async function item(date: string) {
  const id = `recovery-${tag()}`;
  const at = editionAt("daily", date, -12 * 3600);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${id}, ${SOURCE}, ${id}, 'https://example.com/report', ${id}, ${at}, ${at})`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at, eligible, selected, visible_after, visibility, score)
    VALUES (${id}, ${id}, ${SOURCE}, 'news', 'https://example.com/report', ${at}, ${at}, ${at}, true, true, ${at}, 'public', 90)`;
  return id;
}
const report = async (kind: string, key: string) => (await sql`SELECT content, revision, generated_at FROM reports WHERE kind = ${kind} AND key = ${key}`)[0];

async function daily(date: string, id?: string) {
  const sections = id ? [{ label: "行业动态", items: [{ itemId: id, title: id }] }] : [];
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
    VALUES ('daily', ${date}, now(), now(), ${sql.json({ date, sections })}, now())
    ON CONFLICT (kind, key) DO UPDATE SET content = EXCLUDED.content`;
}

async function dailies(start: string, end: string, withItems: string[] = []) {
  for (let date = start; date <= end; date = addDays(date, 1)) {
    await daily(date, withItems.includes(date) ? await item(date) : undefined);
  }
}

test("automatic retries preserve all three published issue kinds; explicit corrections keep a revision", async () => {
  const id = await item("2024-02-02");
  for (const [kind, key, compose] of [
    ["daily", "2024-02-02", composeDaily], ["weekly", "2024-W05", composeWeekly], ["monthly", "2024-02", composeMonthly],
  ] as const) {
    await compose(key);
    const saved = await report(kind, key);
    const calls = provider.hits();
    await sql`UPDATE publications SET title = title || ' corrected' WHERE article_id = ${id}`;
    await compose(key);
    assert.deepEqual(await report(kind, key), saved, `${kind}: an automatic retry preserves the edition`);
    assert.equal(provider.hits(), calls, "no model request for an already published edition");
    await compose(key, "editor correction");
    assert.equal((await report(kind, key)).revision, 2);
    const [revision] = await sql`SELECT v.content FROM report_revisions v JOIN reports r ON r.id = v.report_id WHERE r.kind = ${kind} AND r.key = ${key}`;
    assert.deepEqual(revision.content, saved.content);
  }
});

test("report publication and its receipt commit together and recovery reuses the response", async () => {
  await item("2024-05-02");
  await composeDaily("2024-05-02");
  await sql.unsafe(`CREATE FUNCTION fail_report_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.status = 'completed' AND NEW.purpose = 'report_weekly' THEN RAISE EXCEPTION 'receipt commit interrupted'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER fail_report_receipt BEFORE UPDATE ON receipts FOR EACH ROW EXECUTE FUNCTION fail_report_receipt()`);
  try {
    await assert.rejects(composeWeekly("2024-W18"), /receipt commit interrupted/);
    assert.equal(await report("weekly", "2024-W18"), undefined);
  } finally {
    await sql.unsafe("DROP TRIGGER fail_report_receipt ON receipts; DROP FUNCTION fail_report_receipt()");
  }
  const calls = provider.hits();
  await composeWeekly("2024-W18");
  assert.equal(provider.hits(), calls);
  assert.equal((await report("weekly", "2024-W18")).revision, 1);
  assert.equal((await sql`SELECT status FROM receipts WHERE subject = 'report:weekly:2024-W18'`)[0]!.status, "completed");
});

test("empty older gaps cannot starve a later daily, weekly or monthly", async () => {
  // An older issue carried an item; the days after it are empty. Weeklies and monthlies are compiled from dailies.
  const early = await item("2024-01-23");
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
    VALUES ('daily', '2024-01-23', now(), now(), ${sql.json({ sections: [{ label: "行业动态", items: [{ itemId: early, title: early }] }] })}, now())`;
  await item("2024-02-02");
  // Empty gaps are written as quiet issues (0 publications) instead of failing the whole run; the schedule's
  // limit of 8 issues per run means the catch-up takes a few runs, and none of them may report a failure.
  const failures: string[] = [];
  for (let run = 0; run < 4; run++) {
    const result = await composeDueReports(editionAt("daily", "2024-02-02", 3600));
    failures.push(...result.failed);
    if (result.generated.length === 0) break;
  }
  assert.deepEqual(failures, []);
  for (const [kind, key] of [["daily", "2024-02-02"], ["weekly", "2024-W04"], ["monthly", "2024-01"]]) {
    assert.ok(await report(kind!, key!), `${kind} ${key} was recovered past the empty gaps`);
  }
  // The empty days between are quiet issues, not silent ones: nothing was published in their windows.
  const [gap] = await sql<{ silent: string | null }[]>`SELECT content->>'silent' AS silent FROM reports WHERE kind = 'daily' AND key = '2024-01-24'`;
  assert.equal(gap?.silent, "false");
});

test("a week or month that ended before the first daily is not due, so a site started mid-month runs clean", async () => {
  // The site's first daily is Monday 2024-02-05: the weeks and the month 2024-01 before it have no daily to sum up.
  const first = await item("2024-02-05");
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
    VALUES ('daily', '2024-02-05', now(), now(), ${sql.json({ sections: [{ label: "行业动态", items: [{ itemId: first, title: first }] }] })}, now())`;
  const { generated, failed } = await composeDueReports(editionAt("daily", "2024-02-05", 3600));
  assert.deepEqual([generated, failed], [[], []]);
  assert.equal(await report("weekly", "2024-W05"), undefined);
  assert.equal(await report("monthly", "2024-01"), undefined);
});

test("a complete quiet week is skipped on later runs without using the issue limit, and a corrected daily can fill it", async () => {
  await dailies("2024-01-29", "2024-03-04", ["2024-01-30", "2024-02-14", "2024-02-21", "2024-02-28"]);
  await composeDueReports(editionAt("weekly", "2024-02-05", 60));
  const next = await composeDueReports(editionAt("weekly", "2024-02-19", 60), 1);
  assert.deepEqual(next, { generated: ["weekly:2024-W07"], failed: [] });
  const calls = provider.hits();
  assert.deepEqual(await composeDueReports(editionAt("weekly", "2024-02-19", 1800)), { generated: [], failed: [] });
  assert.equal(provider.hits(), calls, "retrying a quiet week makes no model request");
  const later = await composeDueReports(editionAt("weekly", "2024-03-04", 60));
  assert.deepEqual(later, { generated: ["weekly:2024-W08", "weekly:2024-W09", "monthly:2024-02"], failed: [] });
  assert.equal(await report("weekly", "2024-W06"), undefined, "a quiet period has no published issue");

  await daily("2024-02-08", await item("2024-02-08"));
  assert.deepEqual(await composeDueReports(editionAt("weekly", "2024-03-04", 1800)), { generated: ["weekly:2024-W06"], failed: [] });
  assert.ok(await report("weekly", "2024-W06"), "a skipped period is reconsidered from the current dailies");
});

test("a complete quiet month stays successful across retries and does not starve the next month", async () => {
  await dailies("2024-01-01", "2024-04-01", ["2024-01-02", "2024-03-02"]);
  await composeMonthly("2024-01");
  const calls = provider.hits();
  for (const seconds of [60, 1800]) {
    assert.deepEqual(await composeDueReports(editionAt("monthly", "2024-03-01", seconds), 1), { generated: [], failed: [] });
  }
  assert.equal(await composeMonthly("2024-02"), null);
  assert.equal(await report("monthly", "2024-02"), undefined);
  assert.equal(provider.hits(), calls);
  assert.deepEqual(await composeDueReports(editionAt("monthly", "2024-04-01", 60), 1), { generated: ["monthly:2024-03"], failed: [] });
});

for (const [kind, key, start, end, compose] of [
  ["weekly", "2024-W06", "2024-02-05", "2024-02-11", composeWeekly],
  ["monthly", "2024-02", "2024-02-01", "2024-02-29", composeMonthly],
] as const) {
  test(`a ${kind} with a missing daily still fails instead of appearing quiet`, async () => {
    await assert.rejects(compose(key), /no daily entries/);
    await dailies(start, end);
    await sql`DELETE FROM reports WHERE kind = 'daily' AND key = '2024-02-08'`;
    const calls = provider.hits();
    await assert.rejects(compose(key), /no daily entries/);
    assert.equal(await report(kind, key), undefined);
    assert.equal(provider.hits(), calls);
  });

  test(`a ${kind} whose daily entries were withdrawn is not mistaken for an originally quiet period`, async () => {
    await dailies(start, end);
    const id = await item("2024-02-08");
    await daily("2024-02-08", id);
    await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${id}`;
    const calls = provider.hits();
    await assert.rejects(compose(key), /no daily entries/);
    assert.equal(await report(kind, key), undefined);
    assert.equal(provider.hits(), calls);
  });

  test(`an explicit ${kind} correction with no entries fails and preserves the published issue`, async () => {
    await dailies(start, end, ["2024-02-08"]);
    await compose(key);
    const saved = await report(kind, key);
    const calls = provider.hits();
    await daily("2024-02-08");
    await assert.rejects(compose(key, "editor correction"), /no daily entries/);
    await compose(key);
    assert.deepEqual(await report(kind, key), saved);
    assert.equal((await sql`SELECT 1 FROM report_revisions v JOIN reports r ON r.id = v.report_id WHERE r.kind = ${kind} AND r.key = ${key}`).length, 0);
    assert.equal(provider.hits(), calls);
  });
}

test("quiet first periods start at the site's first daily, while later missing days still fail", async () => {
  await dailies("2024-02-07", "2024-02-29");
  const calls = provider.hits();
  assert.equal(await composeWeekly("2024-W06"), null);
  assert.equal(await composeMonthly("2024-02"), null);
  assert.equal(provider.hits(), calls);
  await sql`DELETE FROM reports WHERE kind = 'daily' AND key = '2024-02-08'`;
  await assert.rejects(composeWeekly("2024-W06"), /no daily entries/);
  await assert.rejects(composeMonthly("2024-02"), /no daily entries/);
});
