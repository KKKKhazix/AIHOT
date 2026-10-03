// A delivery's manual recovery takes an explicit outcome and a note: anything else is a client error that
// changes, sends and records nothing (a mistyped outcome must never resend a content push).
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const TARGET = `test-delivery-${T}`;
const app = await buildApp();
let sent = 0;
const realFetch = globalThis.fetch;
before(async () => {
  config.devAdmin = { displayName: T };
  process.env.TEST_DELIVERY_WEBHOOK = "https://delivery.invalid/test";
  // Any send would land here instead of the network.
  globalThis.fetch = (async () => { sent += 1; return Response.json({ code: 0 }); }) as typeof fetch;
  config.feishuContentPushEnabled = true;
  await sql`INSERT INTO notify_targets (key, purpose, kind, config_ref, enabled)
    VALUES (${TARGET}, 'content', 'feishu_webhook', 'TEST_DELIVERY_WEBHOOK', true)`;
});
after(async () => {
  globalThis.fetch = realFetch;
  config.feishuContentPushEnabled = false;
  await app.close();
  await closeDb();
});

test("manual recovery requires an explicit valid outcome and a note before changing or sending a delivery", async () => {
  for (const payload of [{ note: "checked the group" }, { outcome: null, note: "checked the group" }, { outcome: "typo", note: "checked the group" }, { outcome: "resend" }, { outcome: "resend", note: " " }]) {
    const [row] = await sql<{ id: number }[]>`INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status)
      VALUES (${TARGET}, 'test', 'test', ${`${T}-${JSON.stringify(payload)}`}, 'unknown') RETURNING id`;
    await sql`UPDATE deliveries SET payload = ${sql.json({ id: row!.id })} WHERE id = ${row!.id}`;
    const state = async () => (await sql`SELECT status, attempts, updated_at::text AS version FROM deliveries WHERE id = ${row!.id}`)[0];
    const before = await state();
    const response = await app.inject({ method: "POST", url: `/api/admin/deliveries/${row!.id}/resolve`, headers: { "x-csrf-token": "dev" }, payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.deepEqual(await state(), before);
    assert.equal((await sql`SELECT 1 FROM audit_log WHERE subject = ${`delivery:${row!.id}`}`).length, 0);
  }
  assert.equal(sent, 0, "nothing was sent");
});
