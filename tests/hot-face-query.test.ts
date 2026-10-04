// Failure cases: a source icon losing to a post avatar; choosing a newer post without the avatar
// key; treating JSON null/empty as a missing key; choosing a post outside these stories; same-time
// posts losing the id tie-break; duplicate signals changing the winner; same-name sources changing
// their existing source-id precedence; a source without any avatar disappearing.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import type { HotEntry, HotRanking } from "@aihot/backend/events/hot";
import { rankingExtras } from "@aihot/backend/publication/hot";

after(closeDb);

test("hot faces retain source precedence, latest avatar-key semantics and name collisions", async () => {
  const prefix = `faces-${tag()}`;
  const at = new Date("2026-01-01T00:00:00Z");
  const sources = [
    { key: "icon", name: "icon", icon: "https://example.org/source.png", expected: "https://example.org/source.png" },
    { key: "latest", name: "latest", icon: null, expected: "https://example.org/latest.png" },
    { key: "tie", name: "tie", icon: null, expected: "https://example.org/tie-z.png" },
    { key: "null", name: "null", icon: null, expected: null },
    { key: "empty", name: "empty", icon: null, expected: null },
    { key: "none", name: "none", icon: null, expected: null },
    { key: "same-a", name: "same", icon: "https://example.org/same-a.png", expected: "https://example.org/same-z.png" },
    { key: "same-z", name: "same", icon: null, expected: "https://example.org/same-z.png" },
  ];
  for (const source of sources) await sql`INSERT INTO sources (id, name, kind, tier, icon_url)
    VALUES (${`${prefix}-${source.key}`}, ${`${prefix}-${source.name}`}, 'rss', 'T1', ${source.icon})`;
  const storyIds: number[] = [];
  for (let i = 0; i < 3; i++) {
    const [story] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title)
      VALUES (gen_random_uuid(), ${prefix}) RETURNING id`;
    storyIds.push(story!.id);
  }
  const add = async (source: string, suffix: string, age: number, xPost: Record<string, unknown> | null, stories = [storyIds[0]!]) => {
    const id = `${prefix}-${source}-${suffix}`;
    const time = new Date(+at + age * 1000);
    await sql`INSERT INTO articles (id, source_id, identity_key, url, title, discovered_at, timeline_at, x_post)
      VALUES (${id}, ${`${prefix}-${source}`}, ${id}, ${`https://example.org/${id}`}, ${id}, ${time}, ${time}, ${xPost === null ? null : sql.json(xPost as never)})`;
    for (const story of stories) await sql`INSERT INTO story_signals (story_id, article_id, participant_key, source_id, kind, observed_at)
      VALUES (${story}, ${id}, ${`${prefix}-${source}`}, ${`${prefix}-${source}`}, 'editorial', ${time})`;
  };
  for (const source of sources) await add(source.key, "old", 0, { avatarUrl: "https://example.org/old.png" });
  await add("icon", "new", 10, { avatarUrl: "https://example.org/ignored.png" });
  await add("latest", "latest", 10, { avatarUrl: "https://example.org/latest.png" }, storyIds.slice(0, 2));
  await add("latest", "no-key", 20, {});
  await add("latest", "outside", 30, { avatarUrl: "https://example.org/outside.png" }, [storyIds[2]!]);
  for (const suffix of ["a", "z"]) await add("tie", suffix, 10, { avatarUrl: `https://example.org/tie-${suffix}.png` });
  await add("null", "null", 10, { avatarUrl: null });
  await add("empty", "empty", 10, { avatarUrl: "" });
  await sql`UPDATE articles SET x_post = NULL WHERE source_id = ${`${prefix}-none`}`;
  await add("same-z", "new", 10, { avatarUrl: "https://example.org/same-z.png" });
  const entries: HotEntry[] = storyIds.slice(0, 2).map((storyId, i) => ({
    rank: i + 1, storyId, storyPublicId: `${prefix}-${i}`, title: prefix, heat: 10, trend: "flat", trendPct: 0,
    badges: [], participantCount: sources.length, sourceCount: sources.length, signalCount: 0, reportCount: 1,
    sourceNames: sources.map(source => `${prefix}-${source.name}`), latestAt: at.toISOString(), firstReportAt: at.toISOString(),
    representativeItemId: null, representativeUrl: null, representativeSource: null,
    participants: sources.map(source => ({ name: `${prefix}-${source.name}`, kind: "editorial", tier: "T1" })),
  }));
  const ranking: HotRanking = { id: 1, computedAt: at.toISOString(), ruleVersion: "test", entries, coverage: null };
  const extras = await rankingExtras(ranking);
  const participants = extras.participants(entries[0]!);
  assert.equal(participants.length, new Set(sources.map(source => source.name)).size);
  const avatars = new Map(participants.map(person => [person.name, person.iconUrl ? new URL(person.iconUrl, "http://localhost").searchParams.get("u") : null]));
  for (const source of sources) assert.equal(avatars.get(`${prefix}-${source.name}`), source.expected, source.key);
});
