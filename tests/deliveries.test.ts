// Manual delivery recovery must claim one version before sending or changing its outcome.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { resendDelivery } from "@aihot/backend/notify/deliver";
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
  await sql`DELETE FROM deliveries WHERE target_key = ${TARGET}`;
  await sql`DELETE FROM notify_targets WHERE key = ${TARGET}`;
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

/** Hold writes, but allow both requests to read the same version before their updates race. */
async function hold(id: number) {
  const acquired = gate<number>();
  const release = gate();
  const done = sql.begin(async (tx) => {
    await tx`SELECT id FROM deliveries WHERE id = ${id} FOR UPDATE`;
    const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    acquired.open(row.pid);
    await release.promise;
  });
  const pid = await acquired.promise;
  return {
    release: async () => { release.open(); await done; },
    blocked: async (count: number) => {
      const deadline = performance.now() + 5000;
      // Include waiters queued behind the first blocked UPDATE, not just the direct lock holder.
      while (true) {
        const [row] = await sql<{ n: number }[]>`WITH RECURSIVE waiting(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
          UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
        ) SELECT count(*)::int AS n FROM waiting`;
        if (row.n >= count) return;
        assert.ok(performance.now() < deadline, `expected ${count} blocked delivery updates, got ${row.n}`);
        await delay(10);
      }
    },
  };
}

test("two concurrent retries send once and return a conflict for the losing admin request", async () => {
  const id = await delivery();
  const lock = await hold(id);
  const pending = [resolve(id), resolve(id)];
  // Start Fastify's lazy injection promises while the row is locked.
  const done = Promise.all(pending);
  try { await lock.blocked(2); } finally { await lock.release(); }
  const replies = await done;
  assert.deepEqual(replies.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(replies.find((r) => r.statusCode === 409)!.json().code, "conflict");
  assert.equal(requests.filter((n) => n === id).length, 1);
  assert.equal((await state(id)).attempts, 1);
  assert.equal((await state(id)).status, "sent");
  const audits = await sql`SELECT id FROM audit_log WHERE subject = ${`delivery:${id}`} AND action = 'delivery.resend'`;
  assert.equal(audits.length, 1, "only the winning recovery is audited");
});

test("a stale version cannot resend after a fast failure returns the delivery to failed", async () => {
  const id = await delivery("failed");
  const version = (await state(id)).version;
  answer = async () => Response.json({ code: 99 }, { status: 429 });
  try {
    assert.equal((await resendDelivery(id, version)).status, "failed");
    await assert.rejects(resendDelivery(id, version), { code: "conflict" });
    assert.equal(requests.filter((n) => n === id).length, 1);
    assert.equal((await state(id)).attempts, 1);
    assert.equal((await resolve(id)).statusCode, 200, "a fresh explicit retry remains possible");
    assert.equal((await state(id)).attempts, 2);
  } finally { answer = async () => Response.json({ code: 0 }); }
});

for (const outcome of ["sent", "drop"]) {
  test(`a stale ${outcome} cannot overwrite a retry in flight; another delivery remains independent`, async () => {
    const id = await delivery();
    const other = await delivery();
    const lock = await hold(id);
    const arrived = gate();
    const finish = gate();
    answer = async (sentId) => {
      if (sentId === id) { arrived.open(); await finish.promise; }
      return Response.json({ code: 0 });
    };
    const retry = resolve(id).then((r) => r);
    let marking: ReturnType<typeof resolve> | undefined;
    try {
      await lock.blocked(1);
      marking = resolve(id, outcome).then((r) => r);
      await lock.blocked(2);
      await lock.release();
      await arrived.promise;
      assert.equal((await marking).statusCode, 409);
      assert.equal((await state(id)).status, "sending");
      assert.equal((await resolve(other)).statusCode, 200);
    } finally {
      await lock.release();
      finish.open();
      await Promise.allSettled([retry, marking]);
      answer = async () => Response.json({ code: 0 });
    }
    assert.equal((await retry).statusCode, 200);
    assert.equal((await state(id)).status, "sent");
    assert.equal((await state(id)).attempts, 1);
  });
}

test("disabled pushes and missing credentials leave the retry available without sending", async () => {
  const id = await delivery();
  const before = await state(id);
  config.feishuContentPushEnabled = false;
  try { await assert.rejects(resendDelivery(id), /disabled/); }
  finally { config.feishuContentPushEnabled = true; }
  delete process.env.TEST_DELIVERY_WEBHOOK;
  try { await assert.rejects(resendDelivery(id), /webhook not configured/); }
  finally { process.env.TEST_DELIVERY_WEBHOOK = WEBHOOK; }
  assert.deepEqual(await state(id), before);
  assert.equal(requests.filter((n) => n === id).length, 0);
});
