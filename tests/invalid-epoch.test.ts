import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { FUTURE_TOLERANCE_MS, STALE_ON_DISCOVERY_MS, upsertMaterial } from "@aihot/backend/content/materials";
import { previewSource } from "@aihot/backend/admin/sources";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import type { SourceRow } from "@aihot/backend/sources/types";

const T = tag();
const listings = new Map<string, unknown[]>();
const provider = await stub((_hit, req) => listings.get(req.url) ?? []);
config.allowPrivateNetworkFetch = true;
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

type EpochUnit = "epoch_s" | "epoch_ms";
function source(id: string, unit: EpochUnit, values: unknown[], initialized = true): SourceRow {
  const path = `/${id}`;
  listings.set(path, values.map((published, i) => ({ title: `Article ${i}`, url: `https://example.org/${id}/${i}`, published, body: `Article body ${i}` })));
  return {
    id, name: id, kind: "json_list", tier: "T1", participation_mode: "editorial", first_party: false,
    interval_minutes: 60, enabled: true, cursor: initialized ? { initializedAt: new Date().toISOString() } : null, fail_count: 0,
    config: { url: provider.url + path, titlePaths: ["title"], urlTemplate: "{raw:url}", publishedAtPath: "published",
      publishedAtUnit: unit, summaryPaths: ["body"], summaryIsBody: true },
  };
}
async function saveSource(s: SourceRow) {
  await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
    VALUES (${s.id},${s.name},${s.kind},${sql.json(s.config)},${s.tier},${s.participation_mode},${s.cursor ? sql.json(s.cursor) : null},'2100-01-01')`;
}
const timeline = async (id: string) => (await sql<{
  published_at: Date | null; published_at_claim: Date | null; discovered_at: Date; timeline_at: Date;
  backfill: boolean; backfill_reason: string | null; revision: number;
}[]>`SELECT published_at,published_at_claim,discovered_at,timeline_at,backfill,backfill_reason,revision FROM articles WHERE id=${id}`)[0]!;

for (const unit of ["epoch_s", "epoch_ms"] as const) {
  test(`${unit} parser and preview normalize invalid dates without losing valid epoch values`, async () => {
    const factor = unit === "epoch_s" ? 1000 : 1;
    const values = [0, "0", -1, "-1", 1_700_000_000, "1700000000", null, undefined, "", "unknown", "NaN", "Infinity", "-Infinity", "1e100", 1e100];
    const s = source(`epoch-parser-${unit}-${T}`, unit, values);
    const candidates = await fetchJsonList(s);
    assert.equal(candidates.length, values.length);
    for (const [i, candidate] of candidates.entries()) {
      const expected = i < 6 ? Number(values[i]) * factor : null;
      assert.equal(candidate.publishedAt?.getTime() ?? null, expected, `value ${String(values[i])}`);
      assert.ok(candidate.publishedAt === null || Number.isFinite(candidate.publishedAt?.getTime()));
    }
    const preview = await previewSource(s);
    assert.equal(preview.count, values.length);
    assert.deepEqual(preview.items.map((item) => item.publishedAt), candidates.map((item) => item.publishedAt?.toISOString() ?? null));
  });

  test(`${unit} preserves normally convertible legacy publication values`, async () => {
    const factor = unit === "epoch_s" ? 1000 : 1;
    const values = [true, false, " ", [], [1], ["1"], [[1]], [null], {}];
    const expected = [factor, 0, 0, 0, factor, factor, factor, 0, null];
    const s = source(`epoch-legacy-${unit}-${T}`, unit, values);
    const candidates = await fetchJsonList(s);
    assert.deepEqual(candidates.map((item) => item.publishedAt?.getTime() ?? null), expected);
    const preview = await previewSource(s);
    assert.equal(preview.count, values.length);
    assert.deepEqual(preview.items.map((item) => item.publishedAt), expected.map((time) => time === null ? null : new Date(time).toISOString()));
  });

  for (const invalid of [
    { name: "unknown", value: "unknown" },
    { name: "object", value: { toString: null } },
    { name: "array", value: [{ toString: null }] },
  ]) {
    test(`${unit} preview accepts the ${invalid.name} middle claim`, async () => {
      const s = source(`epoch-preview-${unit}-${invalid.name}-${T}`, unit, [1, invalid.value, 2]);
      const preview = await previewSource(s);
      const factor = unit === "epoch_s" ? 1000 : 1;
      assert.equal(preview.count, 3);
      assert.deepEqual(preview.items.map((item) => item.publishedAt), [new Date(factor).toISOString(), null, new Date(2 * factor).toISOString()]);
    });

    test(`${unit} collection stores the ${invalid.name} middle claim and the following article, then repeats cleanly`, async (t) => {
      const now = Math.floor(Date.now() / 1000) * 1000;
      const factor = unit === "epoch_s" ? 1000 : 1;
      const s = source(`epoch-collect-${unit}-${invalid.name}-${T}`, unit, [now / factor, invalid.value, (now - 1000) / factor]);
      await saveSource(s);
      const first = await collectSource(s.id);
      t.diagnostic(`first collection: ${JSON.stringify(first)}`);
      assert.deepEqual([first.status, first.found, first.created, first.revised], ["ok", 3, 3, 0]);
      const articles = await sql<{ id: string; url: string; processing_queued_at: Date | null }[]>`
        SELECT id,url,processing_queued_at FROM articles WHERE source_id=${s.id} ORDER BY url`;
      assert.equal(articles.length, 3);
      const middle = await timeline(articles[1]!.id);
      assert.deepEqual([middle.published_at, middle.published_at_claim, middle.backfill, middle.backfill_reason], [null, null, false, null]);
      assert.equal(middle.timeline_at.getTime(), middle.discovered_at.getTime());
      assert.ok(articles.every((article) => article.processing_queued_at !== null));
      const queued = await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${articles[2]!.id}`;
      assert.equal(queued.length, 1, "最后一条资料仍进入分析队列");
      const second = await collectSource(s.id);
      assert.deepEqual([second.status, second.found, second.created, second.revised], ["ok", 3, 0, 0]);
      const [health] = await sql`SELECT health,fail_count,last_error FROM sources WHERE id=${s.id}`;
      assert.deepEqual({ ...health }, { health: "ok", fail_count: 0, last_error: null });
      const runs = await sql`SELECT status,found_count,new_count,error FROM fetch_runs WHERE source_id=${s.id} ORDER BY id`;
      assert.deepEqual(runs.map((run) => ({ ...run })), [
        { status: "ok", found_count: 3, new_count: 3, error: null },
        { status: "ok", found_count: 3, new_count: 0, error: null },
      ]);
      assert.equal(Number((await sql`SELECT count(*) AS n FROM articles WHERE source_id=${s.id}`)[0]!.n), 3);
    });
  }
}

test("first-import sorting keeps unknown epoch dates and the normal backfill fallback", async () => {
  const now = Math.floor(Date.now() / 1000);
  const s = source(`epoch-backfill-${T}`, "epoch_s", [now, "unknown", now - 1], false);
  s.config.sortByPublishedAt = true;
  await saveSource(s);
  const result = await collectSource(s.id);
  assert.deepEqual([result.status, result.created], ["ok", 3]);
  const [article] = await sql`SELECT id FROM articles WHERE source_id=${s.id} AND url=${`https://example.org/${s.id}/1`}`;
  const row = await timeline(article!.id);
  assert.deepEqual([row.published_at_claim, row.published_at, row.backfill, row.backfill_reason], [null, null, true, "first-import"]);
  assert.equal(row.timeline_at.getTime(), row.discovered_at.getTime());
});

test("shared storage accepts invalid publication claims from every material entrance", async () => {
  const s = source(`epoch-storage-${T}`, "epoch_ms", []);
  await saveSource(s);
  const discoveredAt = new Date("2026-09-30T12:00:00Z");
  for (const via of ["fetch", "ingest", "import"] as const) {
    const result = await upsertMaterial({ sourceId: s.id, url: `https://example.org/${s.id}/${via}`, title: "Invalid claim", publishedAt: new Date(NaN), discoveredAt, via });
    assert.equal(result.created, true);
    const row = await timeline(result.articleId);
    assert.deepEqual([row.published_at, row.published_at_claim, row.backfill, row.backfill_reason], [null, null, false, null]);
    assert.equal(row.timeline_at.getTime(), discoveredAt.getTime());
  }
});

for (const revised of [false, true]) {
  test(`invalid claim does not break an existing identity's ${revised ? "revised" : "unchanged"} write`, async () => {
    const s = source(`epoch-existing-${revised}-${T}`, "epoch_ms", []);
    await saveSource(s);
    const publishedAt = new Date("2026-09-30T11:00:00Z");
    const input = { sourceId: s.id, url: `https://example.org/${s.id}/item`, title: "Original title", publishedAt, discoveredAt: new Date("2026-09-30T12:00:00Z"), via: "fetch" as const };
    const first = await upsertMaterial(input);
    const again = await upsertMaterial({ ...input, title: revised ? "Updated title" : input.title, publishedAt: new Date(NaN) });
    assert.deepEqual([again.articleId, again.created, again.revised], [first.articleId, false, revised]);
    const row = await timeline(first.articleId);
    assert.equal(row.revision, revised ? 2 : 1);
    assert.equal(row.published_at_claim?.getTime(), publishedAt.getTime());
    assert.equal(row.published_at?.getTime(), publishedAt.getTime());
    const revisions = await sql`SELECT revision FROM article_revisions WHERE article_id=${first.articleId} ORDER BY revision`;
    assert.deepEqual(revisions.map((item) => item.revision), revised ? [1, 2] : [1]);
  });
}

test("storage preserves finite future claims and existing timeline boundaries", async () => {
  const s = source(`epoch-timeline-${T}`, "epoch_ms", []);
  await saveSource(s);
  const discoveredAt = new Date("2026-09-30T12:00:00Z");
  const cases = [
    { name: "future", claim: new Date(discoveredAt.getTime() + FUTURE_TOLERANCE_MS + 1), trusted: false, backfill: null },
    { name: "future-boundary", claim: new Date(discoveredAt.getTime() + FUTURE_TOLERANCE_MS), trusted: true, backfill: null },
    { name: "old", claim: new Date(discoveredAt.getTime() - STALE_ON_DISCOVERY_MS - 1), trusted: true, backfill: "stale-on-discovery" },
    { name: "zero", claim: new Date(0), trusted: true, backfill: "stale-on-discovery" },
    { name: "negative", claim: new Date(-1000), trusted: true, backfill: "stale-on-discovery" },
    { name: "explicit", claim: new Date(NaN), trusted: false, backfill: "manual-backfill" },
  ];
  for (const c of cases) {
    const result = await upsertMaterial({ sourceId: s.id, url: `https://example.org/${s.id}/${c.name}`, title: c.name,
      publishedAt: c.claim, discoveredAt, via: "import", backfill: c.name === "explicit" ? c.backfill : null });
    const row = await timeline(result.articleId);
    assert.equal(row.published_at_claim?.getTime() ?? null, Number.isFinite(c.claim.getTime()) ? c.claim.getTime() : null, c.name);
    assert.equal(row.published_at?.getTime() ?? null, c.trusted ? c.claim.getTime() : null, c.name);
    assert.equal(row.backfill, c.backfill !== null, c.name);
    assert.equal(row.backfill_reason, c.backfill, c.name);
    assert.equal(row.timeline_at.getTime(), c.backfill && c.trusted ? c.claim.getTime() : discoveredAt.getTime(), c.name);
  }
});

test("unrelated storage failures still fail collection visibly", async () => {
  const s = source(`epoch-db-error-${T}`, "epoch_s", [Math.floor(Date.now() / 1000)]);
  await saveSource(s);
  const constraint = `epoch_test_reject_${T}`;
  // 仅对本测试信源加临时约束，确保真实数据库错误仍按原有路径报告。
  await sql.unsafe(`ALTER TABLE articles ADD CONSTRAINT "${constraint}" CHECK (source_id <> '${s.id}') NOT VALID`);
  try {
    const result = await collectSource(s.id);
    assert.equal(result.status, "failed");
    assert.ok(result.error?.includes(constraint));
    const [health] = await sql`SELECT health,fail_count,last_error,cursor FROM sources WHERE id=${s.id}`;
    assert.equal(health!.health, "degraded");
    assert.equal(health!.fail_count, 1);
    assert.ok(health!.last_error.includes(constraint));
    assert.deepEqual(health!.cursor, s.cursor);
    const [run] = await sql`SELECT status,error FROM fetch_runs WHERE source_id=${s.id}`;
    assert.equal(run!.status, "failed");
    assert.ok(run!.error.includes(constraint));
  } finally {
    await sql`ALTER TABLE articles DROP CONSTRAINT ${sql(constraint)}`;
  }
});
