// An X post that only links an X Article is judged on the article: collection
// marks it for extraction, extraction fetches the article by the post's own id and stores it as a new
// revision, and the judging steps read the article. A post whose article cannot be fetched is flagged
// to the model instead of passing for a complete body. Reading the post again is no new revision.
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { loadAnalyzeInput } from "@aihot/backend/editorial/input";
import { renderContext } from "@aihot/backend/editorial/writing";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { collectXShard } from "@aihot/backend/sources/collect";
import { tweetToCandidate } from "@aihot/backend/sources/x";
import type { SdTweet } from "@aihot/backend/providers/socialdata";

const T = tag();
const HANDLE = `xa${T}`;
const SOURCE = `test-xa-${HANDLE}`;
const BASE = BigInt(Date.now()) * 1000n;
const WITH_ARTICLE = String(BASE + 2n);
const WITHOUT_ARTICLE = String(BASE + 1n);

const post = (id: string, articleNo: string): SdTweet => ({
  id_str: id, tweet_created_at: new Date().toISOString(), full_text: "https://t.co/abc", lang: "zxx", user: { name: "Fei", screen_name: HANDLE },
  entities: { urls: [{ url: "https://t.co/abc", expanded_url: `https://x.com/i/article/${articleNo}` }] },
});

const articleCalls: string[] = [];
const socialdata = await stub((_hit, req) => {
  const u = new URL(req.url, "http://stub");
  const article = /^\/twitter\/article\/(\d+)$/.exec(u.pathname)?.[1];
  if (article) {
    articleCalls.push(article);
    // Looked up by the post's id; the post without one answers with the post alone.
    return article === WITH_ARTICLE
      ? { id_str: article, article: { title: "To Seek a Newer World", content_state: { blocks: [
          { type: "unstyled", text: "World Labs is joining AMD." }, { type: "atomic", text: " " }, { type: "header-two", text: "Why" }, { type: "blockquote", text: "Come, my friends" },
        ] } } }
      : { id_str: article };
  }
  return { tweets: [post(WITH_ARTICLE, "777"), post(WITHOUT_ARTICLE, "888")], next_cursor: null };
});
process.env.SOCIALDATA_BASE_URL = socialdata.url;
process.env.SOCIALDATA_API_KEY = "test-key";
config.allowPrivateNetworkFetch = true;

const idOf = async (tweetId: string) => (await sql<{ id: string }[]>`SELECT id FROM articles WHERE identity_key = ${`x:${tweetId}`}`)[0]!.id;

before(async () => {
  await sql`UPDATE budgets SET per_minute = 1000, per_hour = 10000, per_day = 100000 WHERE service = 'socialdata'`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, cursor, next_fetch_at)
            VALUES (${SOURCE}, ${HANDLE}, 'x_search', ${sql.json({ query: `from:${HANDLE} -filter:replies`, searchType: "Latest" })}, 'T1_5', 'editorial',
                    ${sql.json({ initializedAt: new Date().toISOString(), lastTweetId: String(BASE) })}, '2100-01-01')`;
});
after(async () => {
  await socialdata.close();
  await stopBoss();
  await closeDb();
});

test("a post that links an X Article waits for extraction, which brings the article in as a new revision", async () => {
  assert.equal((await collectXShard(`editorial:test-${T}`, [SOURCE])).status, "ok");
  const id = await idOf(WITH_ARTICLE);
  const [queued] = await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE singleton_key = ${id} ORDER BY created_on DESC LIMIT 1`;
  assert.equal(queued?.name, "content.extract-body", "the article comes before judging");

  assert.equal(await extractArticleBody(id), "ok");
  assert.deepEqual(articleCalls.filter((c) => c === WITH_ARTICLE), [WITH_ARTICLE], "looked up by the post's own id, not the link's number");
  const [a] = await sql<{ title: string; body_text: string; body_status: string; revision: number; x_article: { title: string; text: string } }[]>`
    SELECT title, body_text, body_status, revision, x_article FROM articles WHERE id = ${id}`;
  assert.equal(a!.title, "To Seek a Newer World", "a bare link takes the article's title");
  assert.equal(a!.body_status, "ok");
  assert.equal(a!.revision, 2);
  assert.equal(a!.x_article.text, "World Labs is joining AMD.\n\n## Why\n\n> Come, my friends");
  assert.match(a!.body_text, /^https:\/\/x\.com\/i\/article\/777\n\n# To Seek a Newer World\n\nWorld Labs is joining AMD\./);

  const input = (await loadAnalyzeInput(id))!;
  assert.match(String(input.xPost!.text), /【X 长文】To Seek a Newer World\n\nWorld Labs is joining AMD\./, "every judging step reads the article");
  assert.doesNotMatch(renderContext(input), /正文未抓到/);

  // The same post read again (a later search, an overlap) is the version already seen.
  const again = await upsertMaterial({ ...tweetToCandidate(post(WITH_ARTICLE, "777")), sourceId: SOURCE, via: "fetch" });
  assert.equal(again.revised, false);
  assert.equal((await sql<{ revision: number }[]>`SELECT revision FROM articles WHERE id = ${id}`)[0]!.revision, 2);
});

test("extracting the same article again (an admin re-run) neither repeats it nor makes a revision", async () => {
  const id = await idOf(WITH_ARTICLE);
  const [before] = await sql<{ body_text: string; revision: number }[]>`SELECT body_text, revision FROM articles WHERE id = ${id}`;
  for (let i = 0; i < 2; i++) {
    await sql`UPDATE articles SET body_status = 'pending' WHERE id = ${id}`;
    assert.equal(await extractArticleBody(id), "ok");
  }
  const [after] = await sql<{ body_text: string; revision: number; body_status: string }[]>`SELECT body_text, revision, body_status FROM articles WHERE id = ${id}`;
  assert.equal(after!.body_text, before!.body_text);
  assert.equal(after!.revision, before!.revision);
  assert.equal(after!.body_status, "ok");
});

test("an article that cannot be fetched is flagged to the model, not passed off as a complete body", async () => {
  const id = await idOf(WITHOUT_ARTICLE);
  assert.equal(await extractArticleBody(id), "unconfirmed");
  const input = (await loadAnalyzeInput(id))!;
  assert.equal(input.bodyStatus, "unconfirmed");
  assert.match(renderContext(input), /【媒体】含 X 长文链接（正文未抓到）/);
});
