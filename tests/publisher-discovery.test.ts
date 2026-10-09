// Failure cases: a filtered official feed on a shared host claims every community URL; a real
// official discovery cannot repair earlier community attribution; a broad platform prefix shadows
// an independently verified organization; or a truthy string/no explicit scope silently enables it.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { publisherOwnsUrl } from "@aihot/backend/content/provenance";
import { assertSupportedConfig } from "@aihot/backend/sources/config-keys";

after(async () => { await stopBoss(); await closeDb(); });
async function source(tier: string, config: Record<string, unknown> = {}) {
  const id = `publisher-discovery-${tag()}`;
  await sql`INSERT INTO sources(id,name,kind,tier,first_party,config,participation_mode,next_fetch_at)
    VALUES(${id},${id},'json_list',${tier},${tier === "T1"},${sql.json(config as never)},'editorial','2100-01-01')`;
  return id;
}
const discover = (sourceId: string, url: string) => upsertMaterial({ sourceId, url, title: "An original article", via: "fetch" });

test("shared-host ownership requires both the explicit scope and this source's actual discovery", async () => {
  const scope = `https://${tag()}.example/blog`;
  const official = await source("T1", { publisherUrlPrefixes: [scope], publisherRequiresDiscovery: true });
  const community = await source("T2");
  const first = await discover(community, `${scope}/original`);
  assert.equal((await sql`SELECT source_id FROM articles WHERE id=${first.articleId}`)[0]!.source_id, community);
  await discover(official, `${scope}/original`);
  assert.equal((await sql`SELECT source_id FROM articles WHERE id=${first.articleId}`)[0]!.source_id, official);
  const other = await discover(community, `${scope}/someone-else/article`);
  assert.equal((await sql`SELECT source_id FROM articles WHERE id=${other.articleId}`)[0]!.source_id, community);
  const outside = await discover(community, `${scope}room/article`);
  await discover(official, `${scope}room/article`);
  assert.equal((await sql`SELECT source_id FROM articles WHERE id=${outside.articleId}`)[0]!.source_id, community);
});

test("an independent organization on the platform keeps its verified publisher", async () => {
  const scope = `https://${tag()}.example/blog`;
  await source("T1", { publisherUrlPrefixes: [scope], publisherRequiresDiscovery: true });
  const organization = await source("T1", { publisherUrlPrefixes: [`${scope}/research-lab`] });
  const community = await source("T2");
  const first = await discover(community, `${scope}/research-lab/model-release`);
  assert.equal((await sql`SELECT source_id FROM articles WHERE id=${first.articleId}`)[0]!.source_id, organization);
});

test("discovery ownership configuration must be a boolean with an explicit nonempty URL scope", () => {
  const scope = { publisherUrlPrefixes: ["https://shared.example/blog"] };
  assert.doesNotThrow(() => assertSupportedConfig("json_list", { ...scope, publisherRequiresDiscovery: true }));
  assert.doesNotThrow(() => assertSupportedConfig("rss", { ...scope, publisherRequiresDiscovery: false }));
  for (const invalid of ["true", "false", 1, null]) assert.throws(() => assertSupportedConfig("rss", { ...scope, publisherRequiresDiscovery: invalid }));
  assert.throws(() => assertSupportedConfig("web_list", { url: "https://shared.example/blog", publisherRequiresDiscovery: true }));
  assert.throws(() => assertSupportedConfig("rss", { publisherUrlPrefixes: [], publisherRequiresDiscovery: true }));
  assert.equal(publisherOwnsUrl({ id: "bad", kind: "web_list", config: { url: "https://shared.example/blog", publisherRequiresDiscovery: true } }, "https://shared.example/blog/original"), false);
});
