// A weekly writer request sent before the stop that the provider then refuses: after the stop began,
// the catch-up run treats it as an interruption (no failed issue, no failed run, nothing published).
// The stop is the worker's own signal, aborted in this file's process; the provider is a local stub.
import { editionAt, gate, Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { shutdownSignal } from "@aihot/backend/lib/shutdown";
import { composeDaily, composeDueReports } from "@aihot/backend/reports/compose";

const T = tag();
const SOURCE = `report-shutdown-${T}`;
let hold: { asked: ReturnType<typeof gate<void>>; answer: ReturnType<typeof gate<void>> } | null = null;
const provider = await stub(async () => {
  const held = hold;
  hold = null;
  if (held) {
    held.asked.open();
    await held.answer.promise;
    return new Reply(503, { error: "temporarily overloaded" });
  }
  return { choices: [{ message: { content: JSON.stringify({ title: "周报", leadParagraph: "导语", highlights: [1], headline: "本期进展", overview: "总述", themes: [{ heading: "主题", summary: "摘要", refs: [1] }] }) } }] };
});
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = "test-key";
before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${SOURCE}, 'Report shutdown', 'rss', 'T1')`;
});
after(async () => { hold?.answer.open(); await provider.close(); await stopBoss(); await closeDb(); });

test("a weekly writer refused after the stop began leaves catch-up without a failure and the issue unpublished", async () => {
  for (const date of ["2024-05-02", "2024-05-03", "2024-05-04", "2024-05-05", "2024-05-06"]) {
    const id = `report-shutdown-${date}-${T}`;
    const at = editionAt("daily", date, -12 * 3600);
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
      VALUES (${id}, ${SOURCE}, ${id}, ${`https://example.com/${id}`}, ${id}, ${at}, ${at})`;
    await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at, eligible, selected, visible_after, visibility, score)
      VALUES (${id}, ${id}, ${SOURCE}, 'news', ${`https://example.com/${id}`}, ${at}, ${at}, ${at}, true, true, ${at}, 'public', 90)`;
    await composeDaily(date);
  }
  const reports = async () => (await sql<{ kind: string; key: string }[]>`SELECT kind, key FROM reports ORDER BY kind, key`).map((r) => `${r.kind}:${r.key}`);
  const published = await reports();
  const held = hold = { asked: gate(), answer: gate() };
  const running = composeDueReports(editionAt("weekly", "2024-05-06", 60));
  await Promise.race([held.asked.promise, running.then((r) => assert.fail(`catch-up ended before the writer request: ${JSON.stringify(r)}`))]);
  shutdownSignal.abort();
  held.answer.open();
  const { generated, failed } = await running;
  assert.deepEqual(failed, [], "the interrupted weekly is not a failed issue");
  assert.ok(!generated.includes("weekly:2024-W18"));
  assert.deepEqual(await reports(), published, "the weekly is not published without its writer");
});
