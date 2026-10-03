// Failure cases: concurrent claims duplicate a fact; an ambiguous webhook reply looks delivered;
// a retry bypasses target disable/withdrawal; a mirror sends after the first target awaited a withdrawal.
// A lost reply must still suppress regrouped siblings; enabling a group must not replay older items.
// An admin's resolution with a mistyped outcome must not re-send, nor one without a note pass.
import { gate, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { resendDelivery, resolveDelivery } from "@aihot/backend/notify/deliver";
import { pushSelected } from "@aihot/backend/notify/selected";

const T = tag();
const TARGET = `test-delivery-${T}`;
const WEBHOOK = "https://delivery.invalid/test";
const ids: number[] = [];
const requests: number[] = [];
let answer = async (_id: number) => Response.json({ code: 0 });

before(async () => {
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
  await closeDb();
});

/** A delivery that sends the card it stored (a selected article's card is built afresh instead). */
async function delivery(status = "unknown") {
  const [row] = await sql<{ id: number }[]>`INSERT INTO deliveries (target_key, subject_kind, subject_id, dedupe_key, status)
    VALUES (${TARGET}, 'test', 'test', ${`${T}-${ids.length}`}, ${status}) RETURNING id`;
  ids.push(row.id);
  await sql`UPDATE deliveries SET payload = ${sql.json({ id: row.id })} WHERE id = ${row.id}`;
  return row.id;
}
const state = async (id: number) => (await sql<{ status: string; attempts: number; version: string }[]>`
  SELECT status, attempts, updated_at::text AS version FROM deliveries WHERE id = ${id}`)[0];
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

test("an admin resolution names a known outcome and a note, or changes and sends nothing", async () => {
  const id = await delivery();
  const before = await state(id);
  for (const input of [{ outcome: "resent", note: "checked the group" }, { outcome: "sent", note: " " }, { outcome: "drop" }]) {
    // A validation error, which the admin API answers with 400.
    await assert.rejects(resolveDelivery(id, input as never, "test-admin"), { name: "ZodError" });
  }
  assert.deepEqual(await state(id), before);
  assert.equal(requests.filter((n) => n === id).length, 0);
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

test("a lost webhook reply still suppresses another report later grouped into the same fact", async () => {
  const first = await selectedItem();
  const sibling = await selectedItem();
  const before = requests.length;
  answer = async () => { throw new Error("reply lost after the group may have received the card"); };
  try { await pushSelected(first); }
  finally { answer = async () => Response.json({ code: 0 }); }
  assert.equal(requests.length - before, 1);
  const [sent] = await sql<{ status: string }[]>`SELECT status FROM deliveries WHERE target_key = ${TARGET} AND subject_id = ${first}`;
  assert.equal(sent!.status, "unknown");

  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, title) VALUES (${`delivery-fact-${tag()}`}, 'same announcement') RETURNING id`;
  for (const id of [first, sibling]) {
    await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, 'report')`;
    await sql`UPDATE publications SET fact_id = ${fact!.id} WHERE article_id = ${id}`;
  }
  await pushSelected(sibling);
  assert.equal(requests.length - before, 1, "an unknown sibling outcome is not permission to send again");
  assert.equal((await sql`SELECT 1 FROM deliveries WHERE target_key = ${TARGET} AND subject_id = ${sibling}`).length, 0);

  await pushSelected(await selectedItem());
  assert.equal(requests.length - before, 2, "an unrelated announcement can still be delivered");
});

// Failure cases: an already sent article is temporarily removed for regrouping, then reselected
// under a fact key; an earlier fact becomes a different fact; pending/sending/unknown self-deliveries
// are mistaken for permission to send again; a definitely failed delivery loses manual recovery.
test("regrouping the same selected article cannot send it again under a new fact identity", async () => {
  for (const status of ["sent", "unknown", "pending", "sending", "failed"] as const) {
    const id = await selectedItem();
    const before = requests.length;
    await pushSelected(id);
    assert.equal(requests.length - before, 1, "the initial selected article was actually sent through the local webhook");
    const [original] = await sql<{ id: number }[]>`UPDATE deliveries SET status=${status}
      WHERE target_key=${TARGET} AND subject_kind='selected' AND subject_id=${id} RETURNING id`;
    const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,title)
      VALUES(${`self-delivery-fact-${tag()}`},'confirmed announcement') RETURNING id`;
    await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${id},'report')`;
    await sql`UPDATE publications SET fact_id=${fact!.id} WHERE article_id=${id}`;
    if (status === "failed") {
      await resendDelivery(original!.id);
      assert.equal(requests.length - before, 2, "a confirmed failed delivery still has explicit recovery");
    }
    const sent = requests.length;
    await pushSelected(id);
    assert.equal(requests.length, sent, `${status} self-delivery must not be repeated with a new dedupe key`);
    assert.equal((await sql`SELECT 1 FROM deliveries WHERE target_key=${TARGET} AND subject_id=${id}`).length, 1);
  }
});

test("enabling a group excludes earlier content and includes content arriving at its activation time", async () => {
  const enabledAt = new Date(Date.now() - 60_000);
  const before = requests.length;
  await sql`UPDATE notify_targets SET enabled_at = ${enabledAt} WHERE key = ${TARGET}`;
  try {
    for (const [offset, expected] of [[-1, 0], [0, 1]] as const) {
      const id = await selectedItem();
      await sql`UPDATE publications SET discovered_at = ${new Date(enabledAt.getTime() + offset)} WHERE article_id = ${id}`;
      await pushSelected(id);
      assert.equal(requests.length - before, expected, `arrival ${offset}ms relative to activation`);
      assert.equal((await sql`SELECT 1 FROM deliveries WHERE target_key = ${TARGET} AND subject_id = ${id}`).length, expected);
    }
  } finally { await sql`UPDATE notify_targets SET enabled_at = NULL WHERE key = ${TARGET}`; }
});
