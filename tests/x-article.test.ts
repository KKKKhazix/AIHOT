// An X post that only links an X Article is judged on the article: collection
// marks it for extraction, extraction fetches the article by the post's own id and stores it as a new
// revision, and the judging steps read the article. A post whose article cannot be fetched is flagged
// to the model instead of passing for a complete body. Reading the post again is no new revision. A source
// a module reads has its posts' articles fetched too while they are news. Pages get the article as its
// author laid it out: cover, pictures, videos, bold, links, tables, code and embedded posts, with
// styles placed by character (X counts code points, so UTF-16 offsets slip after an emoji).
import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { loadAnalyzeInput } from "@aihot/backend/editorial/input";
import { renderContext } from "@aihot/backend/editorial/writing";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";
import { collectXShard } from "@aihot/backend/sources/collect";
import { tweetToCandidate, xArticleHtml } from "@aihot/backend/sources/x";
import type { SdArticle, SdTweet } from "@aihot/backend/providers/socialdata";

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
  const [a] = await sql<{ title: string; body_text: string; body_status: string; revision: number; x_article: { title: string; text: string; html: string } }[]>`
    SELECT title, body_text, body_status, revision, x_article FROM articles WHERE id = ${id}`;
  assert.equal(a!.title, "To Seek a Newer World", "a bare link takes the article's title");
  assert.equal(a!.body_status, "ok");
  assert.equal(a!.revision, 2);
  assert.equal(a!.x_article.text, "World Labs is joining AMD.\n\n## Why\n\n> Come, my friends");
  assert.equal(a!.x_article.html, "<p>World Labs is joining AMD.</p><h3>Why</h3><blockquote><p>Come, my friends</p></blockquote>", "pages get the article as laid out");
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

test("a post a module reads (sources.uses) has its X Article fetched while it is news; one nobody reads whole is grouped as it is", async () => {
  const used = `test-xa-used-${T}`;
  const unused = `test-xa-unused-${T}`;
  await sql`INSERT INTO sources (id, name, kind, config, tier, participation_mode, uses, next_fetch_at) VALUES
    (${used}, ${`used${T}`}, 'x_search', ${sql.json({})}, 'T2', 'isolated', ${["free-tokens"]}, '2100-01-01'),
    (${unused}, ${`unused${T}`}, 'x_search', ${sql.json({})}, 'T2', 'isolated', ${[]}, '2100-01-01')`;
  const queuedFor = async (sourceId: string, tweetId: string) => {
    const { articleId } = await upsertMaterial({ ...tweetToCandidate(post(tweetId, "999")), sourceId, via: "fetch" });
    await queueProcessing(articleId);
    return (await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE singleton_key = ${articleId} ORDER BY created_on DESC LIMIT 1`)[0]?.name;
  };
  assert.equal(await queuedFor(used, String(BASE + 10n)), QUEUES.extractBody);
  assert.equal(await queuedFor(unused, String(BASE + 11n)), QUEUES.group);
});

const block = (type: string, text: string, extra: Record<string, unknown> = {}) => ({ type, text, inlineStyleRanges: [], entityRanges: [], ...extra });
const atomic = (key: number) => block("atomic", " ", { entityRanges: [{ key, offset: 0, length: 1 }] });
const LAID_OUT: SdArticle = {
  title: "标题",
  cover_url: "https://pbs.twimg.com/media/cover.jpg",
  media_entities: [
    { media_id: "11", media_info: { __typename: "ApiImage", original_img_url: "https://pbs.twimg.com/media/a.jpg", original_img_width: 1080, original_img_height: 609 } },
    { media_id: "12", media_info: { __typename: "ApiVideo", preview_image: { original_img_url: "https://pbs.twimg.com/media/v.jpg", original_img_width: 1280, original_img_height: 720 } } },
  ],
  content_state: {
    blocks: [
      block("unstyled", "👉 兑换码：MDLDM", { inlineStyleRanges: [{ style: "Bold", offset: 6, length: 5 }] }),
      block("header-one", "第一部分"),
      block("unstyled", "1. 股票代码ANT", { inlineStyleRanges: [{ style: "Bold", offset: 0, length: 10 }] }),
      atomic(0),
      block("unordered-list-item", "甲"),
      block("unordered-list-item", "乙"),
      block("ordered-list-item", "一"),
      block("ordered-list-item", "二"),
      block("blockquote", "引言 *不是* 强调"),
      atomic(1),
      atomic(2),
      atomic(3),
      block("unstyled", "详见课程链接和@someone", { entityRanges: [{ key: 4, offset: 2, length: 4 }], inlineStyleRanges: [{ style: "Italic", offset: 0, length: 2 }] }),
      atomic(5),
      atomic(6),
      block("unstyled", " "),
    ],
    entityMap: [
      { key: "0", value: { type: "MEDIA", data: { mediaItems: [{ mediaId: "11" }] } } },
      { key: "1", value: { type: "DIVIDER", data: [] } },
      { key: "2", value: { type: "MARKDOWN", data: { markdown: "| 项 | 值 |\n| --- | --- |\n| a | 1 |" } } },
      { key: "3", value: { type: "TWEET", data: { tweetId: "2114377706603429899" } } },
      { key: "4", value: { type: "LINK", data: { url: "https://example.com/course" } } },
      { key: "5", value: { type: "MEDIA", data: { mediaItems: [{ mediaId: "12" }] } } },
      { key: "6", value: { type: "MARKDOWN", data: { markdown: "```bash\necho hi\n```" } } },
    ],
  },
};
const POST_URL = "https://x.com/someone/status/2114878401190506902";

test("the page gets the article as laid out: cover, headings, emphasis, lists, quotes and pictures", () => {
  const html = xArticleHtml(LAID_OUT, POST_URL)!;
  assert.ok(html.startsWith('<figure><img src="https://pbs.twimg.com/media/cover.jpg"'), html.slice(0, 80));
  assert.match(html, /<p>👉 兑换码：<strong>MDLDM<\/strong><\/p>/);
  assert.match(html, /<h2>第一部分<\/h2>/);
  assert.match(html, /<p><strong>1\. 股票代码ANT<\/strong><\/p>/);
  assert.match(html, /<figure><img src="https:\/\/pbs\.twimg\.com\/media\/a\.jpg" width="1080" height="609" alt=""><\/figure>/);
  assert.match(html, /<ul><li>甲<\/li><li>乙<\/li><\/ul><ol><li>一<\/li><li>二<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>引言 \*不是\* 强调<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.equal(xArticleHtml({ title: "t" }, POST_URL), null, "an article without blocks has no body");
});

test("the laid-out article keeps links, embedded posts, tables, code and video stills", () => {
  const html = xArticleHtml(LAID_OUT, POST_URL)!;
  assert.match(html, /<p><em>详见<\/em><a href="https:\/\/example\.com\/course">课程链接<\/a>和@someone<\/p>/);
  assert.match(html, /<a href="https:\/\/x\.com\/i\/status\/2114377706603429899">x\.com\/i\/status\/21143777066034…<\/a>/);
  assert.match(html, /<table>[\s\S]*<th>项<\/th>[\s\S]*<td>1<\/td>[\s\S]*<\/table>/);
  assert.match(html, /<pre><code class="language-bash">echo hi\n<\/code><\/pre>/);
  assert.match(html, /<figure><a href="https:\/\/x\.com\/someone\/status\/2114878401190506902"><img src="https:\/\/pbs\.twimg\.com\/media\/v\.jpg" width="1280" height="720" alt="">在 X 查看原视频<\/a><\/figure>/);
});

test("a long X article keeps the playable rendition of an inline video and a link to the original", () => {
  const article = structuredClone(LAID_OUT);
  article.media_entities![1]!.media_info = {
    ...article.media_entities![1]!.media_info,
    variants: [
      { url: "https://video.twimg.com/amplify_video/12/pl/v.m3u8", content_type: "application/x-mpegURL" },
      { url: "https://video.twimg.com.evil.example/amplify_video/12/vid/v.mp4", content_type: "video/mp4", bit_rate: 832000 },
      { url: "https://video.twimg.com/amplify_video/12/vid/v.mp4?tag=29", content_type: "video/mp4", bit_rate: 832000 },
    ],
  };
  const html = xArticleHtml(article, POST_URL)!;
  assert.match(html, /<video[^>]*src="https:\/\/video\.twimg\.com\/amplify_video\/12\/vid\/v\.mp4\?tag=29"[^>]*controls[^>]*preload="none"/);
  assert.match(html, /<\/video><a href="https:\/\/x\.com\/someone\/status\/2114878401190506902">在 X 查看原视频<\/a>/);
  assert.doesNotMatch(html, /evil\.example|\.m3u8/);
});
