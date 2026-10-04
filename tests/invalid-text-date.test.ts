import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { collectSource } from "@aihot/backend/sources/collect";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import type { SourceRow } from "@aihot/backend/sources/types";

const T = tag();
const listings = new Map<string, unknown[]>();
const provider = await stub((_hit, req) => listings.get(req.url) ?? []);
config.allowPrivateNetworkFetch = true;
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

function source(unit: "yyyymmdd" | undefined): { source: SourceRow; dates: (Date | null)[] } {
  const id = `text-date-${unit ?? "default"}-${T}`;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const last = new Date(now.getTime() - 1000);
  const values = [unit ? day.replaceAll("-", "") : now.toISOString(),
    { toString: null }, { toString: "shadowed" }, [{ toString: null }], unit ? "20260230" : "not a date", null,
    unit ? day.replaceAll("-", "") : last.toISOString()];
  listings.set(`/${id}`, values.map((published, i) => ({ title: `Article ${i}`, url: `https://example.org/${id}/${i}`, published, body: `Article body ${i}` })));
  const date = unit ? new Date(`${day}T00:00:00Z`) : now;
  return {
    source: {
      id, name: id, kind: "json_list", tier: "T1", participation_mode: "editorial", first_party: false,
      interval_minutes: 60, enabled: true, cursor: { initializedAt: now.toISOString() }, fail_count: 0,
      config: { url: `${provider.url}/${id}`, titlePaths: ["title"], urlTemplate: "{raw:url}", publishedAtPath: "published",
        publishedAtUnit: unit, summaryPaths: ["body"], summaryIsBody: true },
    },
    dates: [date, null, null, null, null, null, unit ? date : last],
  };
}

for (const unit of [undefined, "yyyymmdd"] as const) {
  test(`${unit ?? "default"} date preview keeps malformed values and the following valid item`, async () => {
    const { source: s, dates } = source(unit);
    const candidates = await fetchJsonList(s);
    assert.equal(candidates.length, dates.length);
    assert.deepEqual(candidates.map((candidate) => candidate.publishedAt?.getTime() ?? null), dates.map((date) => date?.getTime() ?? null));
    assert.deepEqual(candidates.map((candidate) => candidate.title), dates.map((_date, i) => `Article ${i}`));
  });

  test(`${unit ?? "default"} malformed text dates do not fail collection or repeated collection`, async () => {
    const { source: s, dates } = source(unit);
    await sql`INSERT INTO sources (id,name,kind,config,tier,participation_mode,cursor,next_fetch_at)
      VALUES (${s.id},${s.name},${s.kind},${sql.json(s.config)},${s.tier},${s.participation_mode},${sql.json(s.cursor!)},'2100-01-01')`;
    const first = await collectSource(s.id);
    assert.deepEqual([first.status, first.found, first.created, first.revised], ["ok", dates.length, dates.length, 0]);
    const articles = await sql<{
      id: string; published_at_claim: Date | null; published_at: Date | null; discovered_at: Date; timeline_at: Date;
      backfill: boolean; backfill_reason: string | null; processing_queued_at: Date | null;
    }[]>`SELECT id,published_at_claim,published_at,discovered_at,timeline_at,backfill,backfill_reason,processing_queued_at
      FROM articles WHERE source_id=${s.id} ORDER BY url`;
    assert.equal(articles.length, dates.length);
    assert.deepEqual(articles.map((article) => article.published_at_claim?.getTime() ?? null), dates.map((date) => date?.getTime() ?? null));
    for (const article of articles.slice(1, -1)) {
      assert.deepEqual([article.published_at, article.backfill, article.backfill_reason], [null, true, "unknown-publication-time"]);
      assert.equal(article.timeline_at.getTime(), article.discovered_at.getTime());
    }
    assert.ok(articles.every((article) => article.processing_queued_at !== null));
    const queued = await sql`SELECT id FROM pgboss.job WHERE name=${QUEUES.analyze} AND data->>'articleId'=${articles.at(-1)!.id}`;
    assert.equal(queued.length, 1);
    const second = await collectSource(s.id);
    assert.deepEqual([second.status, second.found, second.created, second.revised], ["ok", dates.length, 0, 0]);
    const [health] = await sql`SELECT health,fail_count,last_error FROM sources WHERE id=${s.id}`;
    assert.deepEqual({ ...health }, { health: "ok", fail_count: 0, last_error: null });
  });
}
