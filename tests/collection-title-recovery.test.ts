// Failures: a listing's CTA masks a new title, or changing its detail rendering causes a known real
// headline over 100 characters to buy another paid read. An explicit authoritative rule still wins.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { collectSource } from "@aihot/backend/sources/collect";
import { stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
const longTitle = "Protections from model supply chain attacks are inherently flawed, but Aim Labs' new generation of scanners bridges the gaps";
const publishedAt = new Date(Date.now() - 3600000);
const detailReads: string[] = [];
const urls = Object.fromEntries(["known", "new", "forced"].map(name => [name, `https://publisher.example/article-${name}-${T}`]));
const titles = { known: longTitle, new: "A newly published research result", forced: "The authoritative corrected headline" };
const server = http.createServer((req, res) => {
  const target = req.url!.slice(1);
  const name = ["known", "new", "forced"].find(name => target.endsWith(`-${name}-${T}`))!;
  const listing = target.includes("/list-");
  if (!listing) detailReads.push(name);
  res.setHeader("content-type", "text/plain");
  res.end(`Title: A page\nURL Source: ${target}\nPublished Time: ${publishedAt.toISOString()}\nMarkdown Content:\n` +
    (listing ? `[Read the Blog](${urls[name]})` : `# ${titles[name as keyof typeof titles]}\n\nA publisher-supplied article.`));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
config.allowPrivateNetworkFetch = true;
process.env.JINA_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.JINA_API_KEY = "test-key";
before(async () => {
  await sql`UPDATE budgets SET per_minute=1000,per_hour=1000,per_day=1000 WHERE service='jina'`;
  for (const name of ["known", "new", "forced"] as const) {
    const id = `title-recovery-${name}-${T}`;
    const sourceConfig = { url: `https://r.jina.ai/https://publisher.example/list-${name}-${T}`, parseMode: "markdown", detail: {
      maxFetches: 5, titleRegex: "^#\\s+(.+)$", publishedAtRegex: "Published Time:\\s*(\\S+)", ...(name === "forced" ? { titleAuthoritative: true } : {}),
    } };
    await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode,cursor) VALUES (${id},'Title recovery','web_list',${sql.json(sourceConfig)},'T1','editorial',${sql.json({ initializedAt: new Date().toISOString() })})`;
    if (name !== "new") await upsertMaterial({ sourceId: id, url: urls[name]!, title: longTitle, publishedAt, via: "fetch" });
  }
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await stopBoss(); await closeDb(); });

test("a known real headline does not buy a new detail read merely because it is long and the listing says Read the Blog", async () => {
  assert.equal((await collectSource(`title-recovery-known-${T}`)).status, "ok");
  assert.deepEqual(detailReads, []);
  const [article] = await sql`SELECT title,revision FROM articles WHERE url=${urls.known!}`;
  assert.equal(article!.title, longTitle);
  assert.equal(article!.revision, 1);
});

test("a new CTA obtains its title and date from one existing detail rendering path, and does not reread on the next run", async () => {
  const before = detailReads.length;
  const id = `title-recovery-new-${T}`;
  assert.equal((await collectSource(id)).status, "ok");
  assert.equal(detailReads.length - before, 1);
  const [article] = await sql`SELECT title,published_at FROM articles WHERE url=${urls.new!}`;
  assert.equal(article!.title, titles.new);
  assert.equal(article!.published_at.toISOString(), publishedAt.toISOString());
  assert.equal((await collectSource(id)).status, "ok");
  assert.equal(detailReads.length - before, 1);
});

test("an explicit authoritative title rule still replaces a known headline", async () => {
  const before = detailReads.length;
  assert.equal((await collectSource(`title-recovery-forced-${T}`)).status, "ok");
  assert.equal(detailReads.length - before, 1);
  const [article] = await sql`SELECT title FROM articles WHERE url=${urls.forced!}`;
  assert.equal(article!.title, titles.forced);
});
