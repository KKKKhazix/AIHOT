// Heat is counted from the evidence as it stands: a withdrawn report no longer counts and a source
// counts in its current role; participants are independent actors (one company's channels are one,
// every Hacker News author is one); the change compares with the earlier time's full 48-hour window,
// and a source added since then is left out of the comparison.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { heatRows, snapshotHeat, type HotEntry } from "@aihot/backend/events/hot";
import { loadHotStrip, rankingExtras } from "@aihot/backend/publication/hot";
import { loadHot, loadStoryDetail, v1HotTopics } from "@aihot/backend/publication/stories";
import { buildApp } from "../apps/api/src/app.ts";

const T = `hot-${tag()}`;
const AT = new Date("2099-03-01T12:00:00Z");
const H = 3600_000;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

after(async () => {
  await app?.close();
  await closeDb();
});

async function source(key: string, opts: { mode?: string; owner?: string; createdAt?: Date } = {}) {
  const id = `${T}-${key}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, owner_entity_id, created_at, next_fetch_at)
            VALUES (${id}, ${id}, 'rss', 'T2', ${opts.mode ?? "editorial"}, ${opts.owner ?? null}, ${opts.createdAt ?? new Date("2099-01-01")}, '2100-01-01')`;
  return id;
}

let n = 0;
async function signal(story: number, sourceId: string, hoursBefore: number, opts: { author?: string; kind?: string; withdrawn?: boolean; role?: string | null; composite?: boolean; standalone?: boolean } = {}) {
  n += 1;
  const id = `${T}-a${n}`;
  const at = new Date(AT.getTime() - hoursBefore * H);
  await sql`INSERT INTO articles (id, source_id, identity_key, url, title, author, discovered_at, timeline_at)
            VALUES (${id}, ${sourceId}, ${id}, ${`https://example.org/${id}`}, ${id}, ${opts.author ?? null}, ${at}, ${at})`;
  const [analysis] = await sql`INSERT INTO analyses (article_id,input_revision,origin,output)
    VALUES (${id},1,'rule',${sql.json({scope:opts.composite ? 'composite' : 'single'})}) RETURNING id`;
  await sql`INSERT INTO publications (article_id, analysis_id, revision, visibility, eligible, selected, title, source_id, channel, first_party, url, discovered_at, timeline_at, body_mode, sort_at)
    VALUES (${id}, ${analysis!.id}, 1, ${opts.withdrawn ? 'withdrawn' : 'public'}, true, false, ${id}, ${sourceId}, 'news', false, ${`https://example.org/${id}`}, ${at}, ${at}, 'summary', ${at})`;
  if (opts.role !== null) {
    const [f] = await sql`INSERT INTO facts (public_id,story_id,title) VALUES (${id},${story},${id}) RETURNING id`;
    await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${f!.id},${id},${opts.role ?? 'report'})`;
  }
  if (opts.standalone) await sql`INSERT INTO grouping_overrides (article_id,mode,reason) VALUES (${id},'standalone','Reviewed independent roundup')`;
  // The stored key and kind are what the grouping wrote at the time; heat reads the current ones.
  await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
            VALUES (${story}, ${id}, ${`source:${sourceId}`}, ${sourceId}, ${opts.kind ?? "editorial"}, ${at})`;
  return id;
}

async function story() {
  const [s] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title) VALUES (${randomUUID()}, ${T}) RETURNING id`;
  return s!.id;
}
const rowOf = async (id: number, at = AT) => (await heatRows(at)).find((r) => Number(r.story_id) === id);

test("editorial heat follows factual membership; signal-only evidence survives without a fact", async () => {
  const s = await story();
  const report = await signal(s, await source('member'), 1);
  await signal(s, await source('mention'), 1, {role:'mention'});
  await signal(s, await source('orphan'), 1, {role:null});
  await signal(s, await source('composite'), 1, {composite:true});
  await signal(s, await source('signal-only', {mode:'hot_signal'}), 1, {role:null,kind:'signal'});
  await signal(s, await source('independent-signal', {mode:'hot_signal'}), 1, {role:null,kind:'signal',standalone:true});
  await signal(s, await source('independent-report'), 1, {standalone:true});
  const before = await rowOf(s);
  assert.deepEqual([Number(before?.participants),Number(before?.editorial_participants),Number(before?.signal_participants)],[2,1,1]);
  const moved = await story();
  await sql`UPDATE facts SET story_id=${moved} WHERE id IN (SELECT fact_id FROM fact_articles WHERE article_id=${report})`;
  const after = await rowOf(s);
  assert.deepEqual([Number(after?.participants),Number(after?.editorial_participants),Number(after?.signal_participants)],[1,0,1]);
  assert.equal((await sql`SELECT 1 FROM story_signals WHERE story_id=${s}`).length,7,'stale evidence is retained for audit');
});

test("withdrawn reports and changed roles are counted as they stand now", async () => {
  const s = await story();
  await signal(s, await source("a"), 1);
  await signal(s, await source("b"), 1, { withdrawn: true });
  await signal(s, await source("c", { mode: "hot_signal" }), 1, { kind: "editorial" }); // since demoted
  await signal(s, await source("d", { mode: "isolated" }), 1);
  const r = await rowOf(s);
  assert.equal(Number(r?.participants), 2, "a and c; the withdrawn report and the isolated source are out");
  assert.equal(Number(r?.editorial_participants), 1);
  assert.equal(Number(r?.signal_participants), 1);
});

test("one company's channels are one participant; every community author is one", async () => {
  const s = await story();
  await signal(s, await source("owner-x", { owner: `acme-${T}` }), 2);
  await signal(s, await source("owner-y", { owner: `acme-${T}` }), 2);
  // The real community feeds are named in the code; a test source stands for none of them, so here the
  // authors of one ordinary feed stay one participant.
  const feed = await source("feed");
  await signal(s, feed, 2, { author: "alice" });
  await signal(s, feed, 2, { author: "bob" });
  const r = await rowOf(s);
  assert.equal(Number(r?.participants), 2);
});

test("publisher attribution repairs participant identity without rewriting stored evidence", async () => {
  const s = await story();
  const publisher = await source('verified-publisher', {owner:`publisher-${T}`});
  const discovery = await source('aggregator');
  await signal(s, publisher, 2);
  const corrected = await signal(s, discovery, 1);
  assert.equal(Number((await rowOf(s))?.participants),2);
  await sql`UPDATE articles SET source_id=${publisher} WHERE id=${corrected}`;
  assert.equal(Number((await rowOf(s))?.participants),1,'the same publisher is one participant after provenance repair');
  assert.equal((await sql`SELECT source_id FROM story_signals WHERE article_id=${corrected}`)[0]!.source_id,discovery,'the original evidence remains auditable');
});

test("the change compares with the earlier time's full 48-hour window, without sources added since", async () => {
  const s = await story();
  await signal(s, await source("now-1"), 1);
  await signal(s, await source("now-2"), 1);
  // Seen 50 hours ago only: outside the current window, inside the one six hours earlier.
  await signal(s, await source("old"), 50);
  const r = await rowOf(s);
  assert.equal(Number(r?.participants), 2);
  assert.ok(Number(r?.heat_prev) > 0, "the earlier window keeps its first six hours");

  const t = await story();
  const steady = await source("steady");
  await signal(t, steady, 2);
  await signal(t, steady, 8);
  await signal(t, await source("added", { createdAt: new Date(AT.getTime() - 3 * H) }), 1);
  const u = await rowOf(t);
  assert.equal(Number(u?.participants), 2);
  assert.equal(Number(u?.uncomparable), 1, "the source added three hours ago is left out of the change");
  assert.ok(Number(u?.heat_obs) < Number(u?.heat));
});

// Snapshot batching must keep incomplete-hour repair, upsert idempotency and corrected cohort
// counts.
test("hourly snapshots are idempotent and repair an incomplete hour after collection catches up", async () => {
  const s = await story();
  const src = await source("snapshot");
  await signal(s, src, 2);
  await snapshotHeat(AT);
  assert.equal((await sql`SELECT complete FROM story_heat_hourly WHERE story_id = ${s} AND hour = ${AT}`)[0]!.complete, false);
  await sql`UPDATE sources SET last_ok_at = ${new Date(+AT + H)} WHERE id = ${src}`;
  await snapshotHeat(new Date(+AT + H));
  await snapshotHeat(new Date(+AT + H));
  const rows = await sql`SELECT hour, complete, participants FROM story_heat_hourly WHERE story_id = ${s} ORDER BY hour`;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.complete && r.participants === 1));
});

test("an hour taken again updates the cohort after a source changes role", async () => {
  const s = await story();
  const src = await source("cohort");
  const id = await signal(s, src, 2);
  const hour = new Date(Math.floor(Date.now() / H) * H);
  await sql`UPDATE story_signals SET observed_at = ${new Date(+hour - H)} WHERE article_id = ${id}`;
  await sql`UPDATE sources SET created_at = '2020-01-01', last_ok_at = ${new Date()} WHERE id = ${src}`;
  await snapshotHeat(hour);
  await sql`UPDATE sources SET participation_mode = 'hot_signal' WHERE id = ${src}`;
  await snapshotHeat(hour);
  const rows = await sql`SELECT participants, cohort FROM story_heat_hourly WHERE story_id = ${s}`;
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => r.participants === 1 && r.cohort === 0));
});

test("hot cards send a Unicode-safe excerpt while the event keeps its complete public text", async () => {
  const at = new Date(Date.now() - 120_000);
  const intro = "摘要".repeat(238) + "🤖".repeat(4);
  const full = intro + "仅在详情显示".repeat(300);
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES ('hot-card','Hot card','rss','T1','editorial','2100-01-01')`;
  const [s] = await sql<{ id: number; public_id: string }[]>`INSERT INTO stories(public_id,title,summary)
    VALUES (${randomUUID()},'Hot card',${full}) RETURNING id,public_id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts(public_id,story_id,title)
    VALUES (${randomUUID()},${s!.id},'Hot card') RETURNING id`;
  await sql`INSERT INTO articles(id,source_id,identity_key,url,title,discovered_at,timeline_at)
    VALUES ('hot-card','hot-card','hot-card','https://example.org/hot-card','Hot card',${at},${at})`;
  await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES (${fact!.id},'hot-card','report')`;
  await sql`INSERT INTO publications(article_id,source_id,title,summary,url,timeline_at,discovered_at,sort_at,body_mode,eligible,channel,story_id,fact_id)
    VALUES ('hot-card','hot-card','Hot card',${full},'https://example.org/hot-card',${at},${at},${at},'summary',true,'news',${s!.id},${fact!.id})`;
  const entry: HotEntry = { rank: 1, storyId: s!.id, storyPublicId: s!.public_id, title: "Hot card", heat: 10, trend: "flat", trendPct: 0, badges: [], participantCount: 0, sourceCount: 1, signalCount: 0, reportCount: 1, sourceNames: ["Hot card"], latestAt: at.toISOString(), firstReportAt: at.toISOString(), representativeItemId: "hot-card", representativeUrl: "https://example.org/hot-card", representativeSource: "Hot card", participants: [] };
  await sql`INSERT INTO hot_rankings(computed_at,rule_version,entries,published) VALUES (${at},'test',${sql.json([entry] as never)},true)`;
  assert.equal((await loadHot()).entries[0]!.summary, intro + "…");
  assert.equal((await loadStoryDetail(s!.id))!.summary, full, "the event remains the full reading surface");
  await sql`UPDATE stories SET summary='短摘要' WHERE id=${s!.id}`;
  await sql`UPDATE publications SET summary='短摘要' WHERE article_id='hot-card'`;
  assert.equal((await loadHot()).entries[0]!.summary, "短摘要");
});

test("hot covers follow current visibility and full-text rights within one ranking", async () => {
  const src = "cover-scope";
  const at = new Date(Date.now() - 90_000);
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${src},${src},'rss','T1','editorial','2100-01-01')`;
  const [s] = await sql<{ id: number; public_id: string }[]>`INSERT INTO stories (public_id,title)
    VALUES (${randomUUID()},'封面范围') RETURNING id,public_id`;
  const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id,story_id,title)
    VALUES (${randomUUID()},${s!.id},'封面范围') RETURNING id`;
  for (const [id, image] of [["cover-representative", null], ["cover-primary", "primary"], ["cover-fallback", "fallback"]] as const) {
    await sql`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at,media)
      VALUES (${id},${src},${id},${"https://example.org/" + id},${id},${at},${at},
        ${sql.json(image ? [{ kind: "image", url: "https://example.org/" + image + ".png", width: 800, height: 450 }] : [])})`;
    await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${fact!.id},${id},'report')`;
    await sql`INSERT INTO publications (article_id,source_id,title,url,timeline_at,discovered_at,sort_at,body_mode,eligible,channel,story_id,fact_id,score)
      VALUES (${id},${src},${id},${"https://example.org/" + id},${at},${at},${at},${image ? "full" : "summary"},true,'news',${s!.id},${fact!.id},${image === "primary" ? 90 : 80})`;
  }
  const entry: HotEntry = { rank: 1, storyId: s!.id, storyPublicId: s!.public_id, title: "封面范围", heat: 10, trend: "flat", trendPct: 0, badges: [],
    participantCount: 2, sourceCount: 1, signalCount: 0, reportCount: 3, sourceNames: [src], latestAt: at.toISOString(), firstReportAt: at.toISOString(),
    representativeItemId: "cover-representative", representativeUrl: "https://example.org/cover-representative", representativeSource: src, participants: [] };
  await sql`INSERT INTO hot_rankings (computed_at,rule_version,entries,published)
    VALUES (${at},'test',${sql.json([entry] as never)},true)`;
  const cover = async () => {
    const hot = await loadHot();
    assert.equal(hot.entries.length, 1, "the public representative keeps the story on the same ranking");
    const url = hot.entries[0]!.cover?.url;
    return url ? new URL(url, "http://localhost").searchParams.get("u") : null;
  };
  assert.equal(await cover(), "https://example.org/primary.png");
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = 'cover-primary'`;
  assert.equal(await cover(), "https://example.org/fallback.png", "a withdrawn secondary report cannot remain the cover");
  await sql`UPDATE publications SET body_mode = 'summary' WHERE article_id = 'cover-fallback'`;
  assert.equal(await cover(), null, "revoking full-text permission also removes its cover");
});

test("faces are 精选组 sources by tier (T1, T1.5, T2), at most 6; 氛围组 only counts in +N", async () => {
  const facesTag = `hotfaces-${T}`;
  const inputs = [
    { name: "signal T1 with avatar", kind: "signal", tier: "T1", avatar: true },
    { name: "T2 with avatar A", kind: "editorial", tier: "T2", avatar: true },
    { name: "T1 without avatar", kind: "editorial", tier: "T1", avatar: false },
    { name: "T1.5 with avatar", kind: "editorial", tier: "T1_5", avatar: true },
    { name: "signal without avatar", kind: "signal", tier: "T2", avatar: false },
    { name: "T1 with avatar", kind: "editorial", tier: "T1", avatar: true },
    { name: "T2 with avatar B", kind: "editorial", tier: "T2", avatar: true },
    { name: "T2 without avatar", kind: "editorial", tier: "T2", avatar: false },
    { name: "T2 with avatar C", kind: "editorial", tier: "T2", avatar: true },
    { name: "T2 with avatar D", kind: "editorial", tier: "T2", avatar: true },
  ] as const;
  const faceName = (i: number) => `${facesTag}-${inputs[i]!.name}`;
  const faceSourceId = (i: number) => `${facesTag}-${i}`;
  const imageUrl = (i: number) => inputs[i]!.avatar ? `https://example.org/${facesTag}/${i}.png` : null;
  const at = new Date(Date.now() - 60_000);
  for (const [i, person] of inputs.entries()) {
    await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,icon_url,next_fetch_at)
      VALUES (${faceSourceId(i)},${faceName(i)},'rss',${person.tier},${person.kind === "editorial" ? "editorial" : "hot_signal"},${imageUrl(i)},'2100-01-01')`;
    await sql`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at)
      VALUES(${faceSourceId(i)},${faceSourceId(i)},${faceSourceId(i)},${"https://example.org/" + faceSourceId(i)},${faceName(i)},${at},${at})`;
  }
  const entries: HotEntry[] = [];
  for (let i = 0; i < 3; i++) {
    const [s] = await sql<{ id: number; public_id: string }[]>`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},${facesTag}) RETURNING id,public_id`;
    const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${s!.id},${facesTag}) RETURNING id`;
    for (const [p, person] of inputs.entries()) if (person.kind === "editorial") {
      await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${faceSourceId(p)},'report')`;
      await sql`INSERT INTO publications(article_id,source_id,title,url,timeline_at,discovered_at,sort_at,body_mode,eligible,channel)
        VALUES(${faceSourceId(p)},${faceSourceId(p)},${faceName(p)},${"https://example.org/" + faceSourceId(p)},${at},${at},${at},'summary',true,'news')
        ON CONFLICT(article_id) DO NOTHING`;
    }
    for (const [p, person] of inputs.entries()) await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at)
      VALUES(${s!.id},${faceSourceId(p)},${faceSourceId(p)},${faceSourceId(p)},${person.kind},${at})`;
    entries.push({ rank: i + 1, storyId: s!.id, storyPublicId: s!.public_id, title: facesTag, heat: 10, trend: "flat", trendPct: 0, badges: [],
      participantCount: 12, sourceCount: 8, signalCount: 2, reportCount: 5, sourceNames: inputs.map((_, idx) => faceName(idx)), latestAt: at.toISOString(), firstReportAt: at.toISOString(),
      representativeItemId: faceSourceId(1), representativeUrl: "https://example.org/" + faceSourceId(1), representativeSource: faceName(1), participants: [
        ...inputs.map((p, idx) => ({ name: faceName(idx), kind: p.kind, tier: p.tier })),
        { name: `${faceName(5)}（another channel）`, kind: "editorial", tier: "T1" },
      ] });
  }
  const [saved] = await sql<{ id: number }[]>`INSERT INTO hot_rankings(computed_at,rule_version,entries,published)
    VALUES(${at},'test',${sql.json(entries as never)},true) RETURNING id`;
  const ranking = { id: saved!.id, computedAt: at.toISOString(), ruleVersion: "test", entries, coverage: null };
  const extras = await rankingExtras(ranking);
  const full = extras.participants(entries[0]!);
  const home = (await loadHotStrip())![0]!;
  const hot = (await loadHot()).entries[0]!;
  const order = [5, 2, 3, 1, 6, 8, 9, 7, 0, 4];
  assert.deepEqual(full.map(p => p.name), order.map(faceName));
  assert.deepEqual(home.participants, full, "home shows the same faces");
  assert.deepEqual(hot.participants, full, "/hot shows the same faces");
  assert.equal(home.participantCount, 12, "the +N count still includes everyone");
  assert.equal(hot.participantCount, 12);
  assert.deepEqual(full.slice(0, 6).map(p => p.iconUrl ? new URL(p.iconUrl, "http://localhost").searchParams.get("u") : null), order.slice(0, 6).map(imageUrl), "visible faces keep their image or initial");
  assert.equal(full[1]!.iconUrl, null, "a visible initial still takes one of the six slots");
  const signals = extras.participants({ ...entries[0]!, participants: entries[0]!.participants.filter(p => p.kind === "signal") });
  assert.deepEqual(signals, order.filter(i => inputs[i]!.kind === "signal").map(i => ({ name: faceName(i), kind: "signal" })), "no editorial faces means no image URLs at all");
  const external = (await v1HotTopics()).items[0]!;
  assert.equal(external.participantCount, 12);
  assert.deepEqual(external.sourceNames, entries[0]!.sourceNames, "machine clients keep every stored source name");
  assert.deepEqual(Object.keys(external).sort(), ["rank", "id", "title", "source", "links", "sourceCount", "signalCount", "participantCount", "sourceNames", "latestAt"].sort(), "the external hot-topic contract is unchanged");
});

test("search carries exactly the existing topic links and five visible hot links, including after a withdrawal", async () => {
  app ??= await buildApp();
  const at = new Date(Date.now() - 30_000);
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES ('suggestions','Suggestions','rss','T1','editorial','2100-01-01')`;
  const entries: HotEntry[] = [];
  for (let i = 1; i <= 6; i++) {
    const title = `Suggestion ${i}`;
    const id = `suggestion-${i}`;
    const [s] = await sql<{ id: number; public_id: string }[]>`INSERT INTO stories (public_id,title)
      VALUES (${randomUUID()},${title}) RETURNING id,public_id`;
    const [fact] = await sql<{ id: number }[]>`INSERT INTO facts (public_id,story_id,title)
      VALUES (${randomUUID()},${s!.id},${title}) RETURNING id`;
    await sql`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at)
      VALUES (${id},'suggestions',${id},${"https://example.org/" + id},${title},${at},${at})`;
    await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${fact!.id},${id},'report')`;
    await sql`INSERT INTO publications (article_id,source_id,title,url,timeline_at,discovered_at,sort_at,body_mode,eligible,channel,story_id,fact_id)
      VALUES (${id},'suggestions',${title},${"https://example.org/" + id},${at},${at},${at},'summary',true,'news',${s!.id},${fact!.id})`;
    entries.push({ rank: i, storyId: s!.id, storyPublicId: s!.public_id, title, heat: 10, trend: "flat", trendPct: 0, badges: [],
      participantCount: 0, sourceCount: 1, signalCount: 0, reportCount: 1, sourceNames: ["Suggestions"], latestAt: at.toISOString(), firstReportAt: at.toISOString(),
      representativeItemId: id, representativeUrl: "https://example.org/" + id, representativeSource: "Suggestions", participants: [] });
  }
  await sql`INSERT INTO hot_rankings (computed_at,rule_version,entries,published) VALUES (${at},'test',${sql.json(entries as never)},true)`;
  const read = () => app!.inject({ method: "GET", url: "/api/site/search/suggestions" });
  const fullTopics = (await app!.inject({ method: "GET", url: "/api/site/topics" })).json();
  const first = await read();
  assert.equal(first.statusCode, 200);
  const expectedTopics = fullTopics.topics.map((t: { slug: string; name: string; group: string }) => ({ slug: t.slug, name: t.name, group: t.group }));
  const expectedHot = entries.slice(0, 5).map(e => ({ rank: e.rank, title: e.title, to: "/story/" + e.storyPublicId }));
  assert.deepEqual(first.json(), { topics: expectedTopics, hot: expectedHot });
  assert.equal(first.headers["cache-control"], "public, max-age=30, s-maxage=30, must-revalidate");
  assert.ok(first.headers.etag);
  assert.equal((await app!.inject({ method: "GET", url: "/api/site/search/suggestions", headers: { "if-none-match": String(first.headers.etag) } })).statusCode, 304);
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = 'suggestion-1'`;
  const next = await read();
  assert.deepEqual(next.json().hot, entries.slice(1, 6).map(e => ({ rank: e.rank, title: e.title, to: "/story/" + e.storyPublicId })));
  assert.notEqual(next.headers.etag, first.headers.etag);
});
