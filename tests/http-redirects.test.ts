// 重定向测试只使用虚构凭据和回环服务；HTTPS 分支使用禁止联网的传输替身。
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";
import { fetchJsonList } from "@aihot/backend/sources/json-list";
import type { SourceRow } from "@aihot/backend/sources/types";
import { mpArticle } from "@aihot/backend/providers/dajiala";
import { closeDb, sql } from "@aihot/backend/db";

interface Hit { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
type Handler = (hit: Hit, res: http.ServerResponse) => void | Promise<void>;
async function fixture() {
  const hits: Hit[] = [];
  const routes = new Map<string, Handler>();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const hit = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() };
    hits.push(hit);
    const route = routes.get(new URL(hit.url, "http://fixture").pathname);
    if (route) await route(hit, res);
    else { res.writeHead(200, { "content-type": "application/json" }); res.end('{"code":0,"title":"fixture","content":"fixture"}'); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { hits, routes, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const a = await fixture();
const b = await fixture();
const savedPrivate = config.allowPrivateNetworkFetch;
config.allowPrivateNetworkFetch = true;
const key = `fictional-${tag()}`;
let budget: { per_minute: number; per_hour: number; per_day: number } | undefined;
before(async () => {
  [budget] = await sql`SELECT per_minute,per_hour,per_day FROM budgets WHERE service='dajiala'`;
  await sql`UPDATE budgets SET per_minute=1000,per_hour=10000,per_day=100000 WHERE service='dajiala'`;
});
after(async () => {
  config.allowPrivateNetworkFetch = savedPrivate;
  if (budget) await sql`UPDATE budgets SET per_minute=${budget.per_minute},per_hour=${budget.per_hour},per_day=${budget.per_day} WHERE service='dajiala'`;
  await a.close(); await b.close(); await closeDb();
});
function redirect(path: string, location: string, status = 302) {
  a.routes.set(path, (_hit, res) => { res.writeHead(status, { location }); res.end("redirect"); });
}
for (const headers of [{ Authorization: `Bearer ${key}` }, { aUtHoRiZaTiOn: key }, { Cookie: `session=${key}` }, { "Proxy-Authorization": key }, { "X-Unknown-Credential": key }] as Array<Record<string, string>>) {
  test(`cross-origin replay refuses sensitive header ${Object.keys(headers)[0]}`, async () => {
    redirect("/header", b.url + "/capture", 307);
    const count = b.hits.length;
    await assert.rejects(guardedFetch(a.url + "/header", { headers }), /redirect/i);
    assert.equal(b.hits.length, count, "目标服务不得收到请求");
  });
}
for (const body of [JSON.stringify({ key }), ""]) {
  test(`body-bearing request stays origin-bound (${body ? "JSON" : "empty"})`, async () => {
    redirect("/body", b.url + "/capture", 307);
    const count = b.hits.length;
    await assert.rejects(guardedFetch(a.url + "/body", { method: "POST", body }), /redirect/i);
    assert.equal(b.hits.length, count);
  });
}
test("explicit query protection and late relative chain stay bound to the original origin", async () => {
  redirect("/chain", "/next?key=" + key, 307);
  redirect("/next", `//127.0.0.1:${new URL(b.url).port}/capture?key=${key}`, 307);
  const count = b.hits.length;
  const options = { redirectPolicy: "same-origin" as const };
  await assert.rejects(guardedFetch(`${a.url}/chain?key=${key}`, options), /redirect/i);
  assert.equal(b.hits.length, count);
});
test("ordinary public headers allow a different-origin redirect", async () => {
  redirect("/public", b.url + "/public");
  const headers = { Accept: "text/plain", "Accept-Language": "en", "User-Agent": "fixture", "If-None-Match": '"fixture"', "If-Modified-Since": "Wed, 01 Jan 2020 00:00:00 GMT", Range: "bytes=0-100", "If-Range": '"fixture"', "Cache-Control": "no-cache" };
  const result = await guardedFetch(a.url + "/public", { headers });
  assert.equal(result.status, 200);
  assert.equal(result.url, b.url + "/public");
  assert.equal(b.hits.at(-1)!.method, "GET");
});
for (const status of [301, 302, 303, 307, 308]) {
  for (const method of ["POST", "PUT", "GET", "HEAD"]) {
    test(`same-origin ${status} preserves expected ${method} semantics`, async () => {
      const path = `/method-${status}-${method}`;
      redirect(path, "/final", status);
      const hasBody = method === "POST" || method === "PUT";
      const body = hasBody ? "fixture-body" : undefined;
      const headers = { Authorization: key, ...(hasBody ? { "Content-Type": "application/json", "Content-Language": "en", "Content-Location": "/body", "Content-Encoding": "identity", "Content-Length": String(Buffer.byteLength(body!)) } : {}) };
      const before = structuredClone(headers);
      await guardedFetch(a.url + path, { method: method.toLowerCase(), headers, body });
      const converted = ((status === 301 || status === 302) && method === "POST") || (status === 303 && method !== "GET" && method !== "HEAD");
      const hit = a.hits.at(-1)!;
      assert.equal(hit.method, converted ? "GET" : method);
      assert.equal(hit.body, converted ? "" : body ?? "");
      assert.equal(hit.headers.authorization, key);
      if (converted) for (const name of ["content-type", "content-language", "content-location", "content-encoding", "content-length"]) assert.equal(hit.headers[name], undefined, name);
      assert.deepEqual(headers, before, "不得修改调用方头对象");
    });
  }
}
for (const status of [300, 304, 305]) {
  test(`non-redirect ${status} with Location is returned without another request`, async () => {
    redirect("/not-redirect", b.url + "/unexpected", status);
    const count = b.hits.length;
    const result = await guardedFetch(a.url + "/not-redirect");
    assert.equal(result.status, status);
    assert.equal(b.hits.length, count);
  });
}
test("protected request remains bound after its body was removed by 303", async () => {
  redirect("/drop", "/after-drop", 303); redirect("/after-drop", b.url + "/capture", 302);
  const count = b.hits.length;
  await assert.rejects(guardedFetch(a.url + "/drop", { method: "POST", body: key }), /redirect/i);
  assert.equal(b.hits.length, count);
});
test("synthetic HTTPS downgrade is refused before target dispatch without TLS bypass", async () => {
  const previous = getGlobalDispatcher();
  const mock = new MockAgent(); mock.disableNetConnect();
  let targets = 0;
  mock.get("https://secure.invalid").intercept({ path: "/secret" }).reply(302, "", { headers: { location: "http://secure.invalid/capture" } });
  mock.get("http://secure.invalid").intercept({ path: "/capture" }).reply(() => { targets++; return { statusCode: 200, data: "unexpected" }; });
  setGlobalDispatcher(mock);
  try {
    await assert.rejects(guardedFetch("https://secure.invalid/secret", { headers: { Authorization: key }, route: "direct" }), /redirect/i);
    assert.equal(targets, 0);
  } finally { setGlobalDispatcher(previous); await mock.close(); }
});
test("redirect limits do not expose query credentials", async () => {
  redirect("/cycle", "/cycle?key=" + key);
  await assert.rejects(guardedFetch(`${a.url}/cycle?key=${key}`, { maxRedirects: 1 }), (error: Error) => {
    assert.match(error.message, /redirect/i); assert.ok(!error.message.includes(key)); return true;
  });
});
test("one deadline and response byte limit remain effective", async () => {
  a.routes.set("/slow", async (_hit, res) => { await new Promise(resolve => setTimeout(resolve, 65)); res.writeHead(302, { location: "/slow" }); res.end(); });
  await assert.rejects(guardedFetch(a.url + "/slow", { timeoutMs: 100, maxRedirects: 9 }), { name: "TimeoutError" });
  a.routes.set("/large", (_hit, res) => { res.end("x".repeat(1000)); });
  await assert.rejects(guardedFetch(a.url + "/large", { maxBytes: 100 }), /too large/i);
});
test("normal private-network guards still refuse direct and redirect destinations", async () => {
  config.allowPrivateNetworkFetch = false;
  try {
    const count = b.hits.length;
    await assert.rejects(guardedFetch(b.url + "/secret"), /Blocked/);
    config.allowPrivateNetworkFetch = true;
    a.routes.set("/guarded-hop", (_hit, res) => {
      // 初始回环请求到达后恢复正常校验，验证下一跳确实再次经过目的地检查。
      config.allowPrivateNetworkFetch = false;
      res.writeHead(302, { location: b.url + "/secret" }); res.end();
    });
    await assert.rejects(guardedFetch(a.url + "/guarded-hop"), /Blocked/);
    assert.equal(b.hits.length, count);
  } finally { config.allowPrivateNetworkFetch = true; }
});
test("opaque JSON-source query configuration cannot redirect to another origin", async () => {
  redirect("/json", b.url + "/json?api_key=" + key);
  b.routes.set("/json", (_hit, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('[{"title":"fixture","url":"https://example.org/item"}]'); });
  const source: SourceRow = { id: "redirect-fixture", name: "fixture", kind: "json_list", tier: "T1", participation_mode: "editorial", first_party: false, interval_minutes: 60, enabled: true, cursor: null, fail_count: 0, config: { url: `${a.url}/json?api_key=${key}`, titlePaths: ["title"], urlTemplate: "{raw:url}" } };
  const count = b.hits.length;
  await assert.rejects(fetchJsonList(source), /redirect/i);
  assert.equal(b.hits.length, count);
});
test("Dajiala query credentials use the restricted policy through real receipt handling", async () => {
  process.env.DAJIALA_BASE_URL = a.url; process.env.DAJIALA_KEY = key;
  a.routes.set("/fbmain/monitor/v3/article_detail", (hit, res) => { res.writeHead(302, { location: b.url + "/provider" + new URL(hit.url, a.url).search }); res.end(); });
  const count = b.hits.length;
  await assert.rejects(mpArticle("https://example.org/fixture", { subject: key, identity: key }), /redirect/i);
  assert.equal(b.hits.length, count);
});

test("opaque JSON and Dajiala query callers retain same-origin redirects", async () => {
  redirect("/json-safe", "/json-final?api_key=" + key);
  a.routes.set("/json-final", (_hit, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('[{"title":"same-origin","url":"https://example.org/safe"}]'); });
  const source: SourceRow = { id: "same-origin", name: "fixture", kind: "json_list", tier: "T1", participation_mode: "editorial", first_party: false, interval_minutes: 60, enabled: true, cursor: null, fail_count: 0, config: { url: `${a.url}/json-safe?api_key=${key}`, titlePaths: ["title"], urlTemplate: "{raw:url}" } };
  assert.equal((await fetchJsonList(source))[0]!.title, "same-origin");
  process.env.DAJIALA_BASE_URL = a.url; process.env.DAJIALA_KEY = key;
  a.routes.set("/fbmain/monitor/v3/article_detail", (hit, res) => { res.writeHead(302, { location: "/provider-final" + new URL(hit.url, a.url).search }); res.end(); });
  const result = await mpArticle("https://example.org/safe", { subject: key + "-safe", identity: key + "-safe" });
  assert.equal(result.content, "fixture");
  assert.equal(new URL(a.hits.at(-1)!.url, a.url).searchParams.get("key"), key);
});
