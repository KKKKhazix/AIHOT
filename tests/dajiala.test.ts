// WeChat accounts through Dajiala: a body that failed for a passing reason is fetched again on the
// next check and the article goes back to analysis; a body already stored is not bought again; the key
// the requests carry in their query never follows a redirect to another origin.
import { Reply, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { mpArticle } from "@aihot/backend/providers/dajiala";
import { checkMpAccount } from "@aihot/backend/sources/mp";

const T = tag();
const MP_SOURCE = `test-mp-${T}`;

// Dajiala: one new post whose body answers 503 the first time.
const MP_URL = `https://mp.weixin.qq.com/s/test-${T}`;
let bodyCalls = 0;
const dajiala = await stub((_hit, req) => {
  if (req.url.startsWith("/fbmain/monitor/v3/post_history")) {
    return { code: 0, data: [{ position: 1, url: MP_URL, title: `公众号文章 ${T}`, post_time: Math.floor(Date.now() / 1000) - 3600, digest: "摘要", sn: `sn-${T}` }], remain_money: 100 };
  }
  bodyCalls += 1;
  if (bodyCalls === 1) return new Reply(503, { error: "busy" });
  return { code: 0, title: `公众号文章 ${T}`, content: `<p>正文第一段 ${T}</p><p>正文第二段</p>`, author: "作者", desc: "描述" };
});

process.env.DAJIALA_BASE_URL = dajiala.url;
process.env.DAJIALA_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

before(async () => {
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'dajiala'`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
            VALUES (${MP_SOURCE}, 'Test mp', 'mp_account', ${sql.json({ ghid: `gh_${T}` })}, 'T1', 'editorial',
                    ${sql.json({ lastCheckedAt: new Date().toISOString() })}, '2100-01-01')`;
});
after(async () => {
  await dajiala.close();
  await stopBoss();
  await closeDb();
});

test("a WeChat body that failed for a passing reason is fetched on the next check and analysed again", async () => {
  const article = async () =>
    (await sql<{ body_status: string; revision: number; retry: { attempts: number } | null }[]>`
      SELECT body_status, revision, raw->'dajiala'->'bodyRetry' AS retry FROM articles WHERE source_id = ${MP_SOURCE}`)[0]!;

  const first = await checkMpAccount(MP_SOURCE, "manual");
  assert.equal(first.status, "ok");
  assert.deepEqual({ ...(await article()) }, { body_status: "none", revision: 1, retry: { attempts: 1, error: 'dajiala HTTP 503: {"error":"busy"}' } });

  const second = await checkMpAccount(MP_SOURCE, "manual");
  assert.equal(second.status, "ok");
  assert.equal(bodyCalls, 2, "the body is asked for once more");
  const now = await article();
  assert.deepEqual([now.body_status, now.revision, now.retry], ["ok", 2, null], "the body arrives as a new revision and retrying stops");
  const [queued] = await sql<{ processing_state: string }[]>`SELECT processing_state FROM articles WHERE source_id = ${MP_SOURCE}`;
  assert.equal(queued!.processing_state, "new", "the article goes back to analysis");

  await checkMpAccount(MP_SOURCE, "manual");
  assert.equal(bodyCalls, 2, "a body already stored is not bought again");
});

/** A plain HTTP origin for redirect answers; `hits` records every request it receives. */
async function origin(answer: (url: URL, res: http.ServerResponse) => void) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => { hits.push(req.url!); answer(new URL(req.url!, "http://origin"), res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { hits, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("the Dajiala key never follows a redirect to another origin; a same-origin redirect still works", async () => {
  const json = (res: http.ServerResponse) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"code":0,"title":"fixture","content":"fixture"}'); };
  const elsewhere = await origin((_url, res) => json(res));
  let cross = true;
  const provider = await origin((url, res) => {
    if (url.pathname !== "/fbmain/monitor/v3/article_detail") return json(res);
    res.writeHead(302, { location: cross ? `${elsewhere.url}/provider${url.search}` : `/provider-final${url.search}` });
    res.end();
  });
  const saved = process.env.DAJIALA_BASE_URL;
  process.env.DAJIALA_BASE_URL = provider.url;
  try {
    await assert.rejects(mpArticle("https://example.org/cross", { subject: `${T}-cross`, identity: `${T}-cross` }), /redirect/i);
    assert.equal(elsewhere.hits.length, 0, "the key never reaches another origin");
    cross = false;
    assert.equal((await mpArticle("https://example.org/same", { subject: `${T}-same`, identity: `${T}-same` })).content, "fixture");
    assert.equal(new URL(provider.hits.at(-1)!, provider.url).searchParams.get("key"), "test-key");
  } finally {
    process.env.DAJIALA_BASE_URL = saved;
    await provider.close();
    await elsewhere.close();
  }
});
