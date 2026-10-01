// Failure cases: concurrent claims duplicate a fact; an ambiguous webhook reply looks delivered;
// a retry bypasses target disable/withdrawal; a mirror sends after the first target awaited a withdrawal.
// An invalid or missing manual outcome must never be interpreted as permission to resend.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { deliverContent, resendDelivery } from "@aihot/backend/notify/deliver";
import { pushSelected } from "@aihot/backend/notify/selected";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const TARGET = `test-delivery-${T}`;
const WEBHOOK = "https://delivery.invalid/test";
const app = await buildApp();
const ids: number[] = [];
const requests: number[] = [];
let answer = async (_id: number) => Response.json({ code: 0 });

before(async () => {
  config.devAdmin = { displayName: T };
  process.env.TEST_DELIVERY_WEBHOOK = WEBHOOK;
  // Exercise the live branch entirely in-process; any unexpected network request fails the test.
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), WEBHOOK);
    const id = JSON.parse(String(init?.body)).card.id as number;
    requests.push(id);
    return answer(id);
  }) as typeof fetch;
  config.feishuContentPushEnabled = true;
  await sql`INSERT INTO notify_targets (key, purpose, kind, config_ref, enabled)
    VALUES (${TARGET}, 'content', 'feishu_webhook', 'TEST_DELIVERY_WEBHOOK', true)`;
});
const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  config.feishuContentPushEnabled = false;
  await app.close();
  await sql`DELETE FROM audit_log WHERE actor = ${`dev:${T}`}`;
  await sql`DELETE FROM deliveries WHERE target_key LIKE ${TARGET + '%'}`;
  await sql`DELETE FROM notify_targets WHERE key LIKE ${TARGET + '%'}`;
  await closeDb();
});

async function delivery(status = "unknown") {
  const [row] = await sql<{ id: number }[]>`INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status)
    VALUES (${TARGET}, 'codex_reset', 'test', ${`${T}-${ids.length}`}, ${status}) RETURNING id`;
  ids.push(row.id);
  await sql`UPDATE deliveries SET payload = ${sql.json({ id: row.id })} WHERE id = ${row.id}`;
  return row.id;
}
const state = async (id: number) => (await sql<{ status: string; attempts: number; version: string }[]>`
  SELECT status, attempts, updated_at::text AS version FROM deliveries WHERE id = ${id}`)[0];
const resolve = (id: number, outcome = "resend") => app.inject({
  method: "POST", url: `/api/admin/deliveries/${id}/resolve`, headers: { "x-csrf-token": "dev" },
  payload: { outcome, note: "checked the group" },
});

test("manual recovery requires an explicit valid outcome before changing or sending a delivery", async () => {
  for (const outcome of [undefined, null, "typo"]) {
    const id = await delivery();
    const before = await state(id);
    const response = await app.inject({
      method: "POST", url: `/api/admin/deliveries/${id}/resolve`, headers: { "x-csrf-token": "dev" },
      payload: { ...(outcome === undefined ? {} : { outcome }), note: "checked the group" },
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(await state(id), before);
    assert.equal(requests.filter((n) => n === id).length, 0);
    assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject = ${`delivery:${id}`}`).length, 0);
  }
});

test("only an explicit webhook acknowledgement counts as delivered", async () => {
  for (const [reply, expected] of [
    [() => new Response("<html>proxy error</html>"), "unknown"],
    [() => Response.json({}), "unknown"],
    [() => Response.json(null), "unknown"],
    [() => Response.json({ code: 0 }, { status: 503 }), "unknown"],
    [() => Response.json({ code: 99 }), "failed"],
    [() => new Response("rejected", { status: 400 }), "failed"],
    [() => Response.json({ StatusCode: 0 }), "sent"],
    [() => Response.json({ code: 0 }), "sent"],
    [() => { throw new Error("connection lost"); }, "unknown"],
  ] as const) {
    const id = await delivery("failed");
    answer = async () => reply();
    try {
      assert.equal((await resendDelivery(id)).status, expected);
      assert.equal((await state(id)).status, expected);
    } finally { answer = async () => Response.json({ code: 0 }); }
  }
});

test("a disabled target cannot receive a manual retry", async () => {
  const id = await delivery();
  const before = await state(id);
  await sql`UPDATE notify_targets SET enabled = false WHERE key = ${TARGET}`;
  try {
    await assert.rejects(resendDelivery(id), /disabled|停用/);
    assert.deepEqual(await state(id), before);
    assert.equal(requests.filter((n) => n === id).length, 0);
  } finally { await sql`UPDATE notify_targets SET enabled = true WHERE key = ${TARGET}`; }
});

async function selectedItem() {
  const id = `delivery-item-${tag()}`;
  await sql`INSERT INTO sources (id, name, kind, tier) VALUES (${TARGET}, 'Delivery test', 'rss', 'T1') ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at)
    VALUES (${id}, ${TARGET}, ${id}, 'https://example.com/delivery', ${id}, now(), now())`;
  await sql`INSERT INTO publications (article_id, title, source_id, channel, url, discovered_at, timeline_at, sort_at, eligible, selected, visible_after, visibility)
    VALUES (${id}, ${id}, ${TARGET}, 'news', 'https://example.com/delivery', now(), now(), now(), true, true, now() - interval '1 minute', 'public')`;
  return id;
}

test("a withdrawn selected item cannot be sent through manual recovery", async () => {
  const articleId = await selectedItem();
  const id = await delivery();
  await sql`UPDATE deliveries SET subject_kind = 'selected', subject_id = ${articleId} WHERE id = ${id}`;
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${articleId}`;
  await assert.rejects(resendDelivery(id), /不可推送|not public|不再/);
  assert.equal(requests.filter((n) => n === id).length, 0);
  assert.equal((await state(id)).status, "unknown");
});

test("a withdrawal while one target is sending stops the following mirror", async () => {
  const articleId = await selectedItem();
  const mirror = `${TARGET}-mirror`;
  await sql`INSERT INTO notify_targets (key, purpose, kind, config_ref, enabled)
    VALUES (${mirror}, 'content', 'feishu_webhook', 'TEST_DELIVERY_WEBHOOK', true)`;
  const arrived = gate();
  const finish = gate();
  const before = requests.length;
  answer = async () => { arrived.open(); await finish.promise; return Response.json({ code: 0 }); };
  const sending = pushSelected(articleId);
  try {
    await arrived.promise;
    await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${articleId}`;
    finish.open();
    await sending;
    assert.equal(requests.length - before, 1, "only the already in-flight card leaves");
  } finally {
    finish.open(); await sending;
    answer = async () => Response.json({ code: 0 });
    await sql`UPDATE notify_targets SET enabled = false WHERE key = ${mirror}`;
  }
});

test("concurrent sibling claims reserve a target once, including the pending delivery", async () => {
  const blocker = gate<number>();
  const release = gate();
  const holding = sql.begin(async (tx) => {
    await tx`LOCK TABLE deliveries IN SHARE MODE`;
    blocker.open((await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
    await release.promise;
  });
  const pid = await blocker.promise;
  const subjects = [`${T}-sibling-a`, `${T}-sibling-b`];
  const before = requests.length;
  const done = Promise.all(subjects.map((subjectId) => deliverContent({
    subjectKind: "codex_reset", subjectId, dedupeKey: subjectId, contentAt: new Date(), card: { id: 999 }, siblings: subjects,
  })));
  try {
    const deadline = performance.now() + 5000;
    while (true) {
      const [row] = await sql<{ n: number }[]>`WITH RECURSIVE waiting(pid) AS (
        SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
        UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
      ) SELECT count(*)::int AS n FROM waiting`;
      if (row!.n >= 2) break;
      assert.ok(performance.now() < deadline, "both target claims reach the held delivery table");
      await delay(10);
    }
  } finally { release.open(); await holding; }
  await done;
  assert.equal(requests.length - before, 1);
});
