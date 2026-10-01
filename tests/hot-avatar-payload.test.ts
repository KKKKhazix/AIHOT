import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { closeDb, sql } from '@aihot/backend/db';
import { loadHotStrip, rankingExtras } from '@aihot/backend/publication/hot';
import type { HotEntry } from '@aihot/backend/events/hot';
import { proxiedImage } from '@aihot/backend/media/imgproxy';

const t = `hotfaces-${tag()}`;
// Listed in the ranking's stored order, which the faces must not follow.
const inputs = [
  { name: 'signal T1 with avatar', kind: 'signal', tier: 'T1', avatar: true },
  { name: 'T2 with avatar A', kind: 'editorial', tier: 'T2', avatar: true },
  { name: 'T1 without avatar', kind: 'editorial', tier: 'T1', avatar: false },
  { name: 'T1.5 with avatar', kind: 'editorial', tier: 'T1_5', avatar: true },
  { name: 'signal without avatar', kind: 'signal', tier: 'T2', avatar: false },
  { name: 'T1 with avatar', kind: 'editorial', tier: 'T1', avatar: true },
  { name: 'T2 with avatar B', kind: 'editorial', tier: 'T2', avatar: true },
  { name: 'T2 without avatar', kind: 'editorial', tier: 'T2', avatar: false },
  { name: 'T2 with avatar C', kind: 'editorial', tier: 'T2', avatar: true },
  { name: 'T2 with avatar D', kind: 'editorial', tier: 'T2', avatar: true },
] as const;
const name = (i: number) => `${t}-${inputs[i]!.name}`;
const sourceId = (i: number) => `${t}-${i}`;
const imageUrl = (i: number) => inputs[i]!.avatar ? `https://example.org/${t}/${i}.png` : null;
let rankingId: number | undefined;
const storyIds: number[] = [];
after(async () => {
  if (rankingId !== undefined) await sql`DELETE FROM hot_rankings WHERE id=${rankingId}`;
  if (storyIds.length) await sql`DELETE FROM story_signals WHERE story_id=ANY(${storyIds}::bigint[])`;
  if (storyIds.length) await sql`DELETE FROM facts WHERE story_id=ANY(${storyIds}::bigint[])`;
  if (storyIds.length) await sql`DELETE FROM stories WHERE id=ANY(${storyIds}::bigint[])`;
  await sql`DELETE FROM articles WHERE source_id LIKE ${t+'%'}`;
  await sql`DELETE FROM sources WHERE id LIKE ${t+'%'}`;
  await closeDb();
});

test('faces are 精选组 sources by tier (T1, T1.5, T2), at most 6; 氛围组 only counts in +N', async () => {
  for (const [i, person] of inputs.entries()) {
    await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,icon_url,next_fetch_at)
      VALUES (${sourceId(i)},${name(i)},'rss',${person.tier},${person.kind === 'editorial' ? 'editorial' : 'hot_signal'},${imageUrl(i)},'2100-01-01')`;
    await sql`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at)
      VALUES(${sourceId(i)},${sourceId(i)},${sourceId(i)},${'https://example.org/'+sourceId(i)},${name(i)},now(),now())`;
  }
  // A visible ranking now needs a currently public editorial report, just like a real event.
  // One report may cover these three events; avatar order still comes from the same ten sources.
  await sql`INSERT INTO publications (article_id,source_id,title,url,timeline_at,discovered_at,sort_at,eligible,channel)
    VALUES (${sourceId(1)},${sourceId(1)},${name(1)},${'https://example.org/'+sourceId(1)},now(),now(),now(),true,'news')`;
  const entries: HotEntry[] = [];
  const at = new Date('2099-01-01T00:00:00Z');
  for (let i=0;i<3;i++) {
    const [story] = await sql<{id:number;public_id:string}[]>`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},${t}) RETURNING id,public_id`;
    storyIds.push(story!.id);
    const [fact] = await sql<{id:number}[]>`INSERT INTO facts (public_id,story_id,title)
      VALUES (${randomUUID()},${story!.id},${t}) RETURNING id`;
    await sql`INSERT INTO fact_articles (fact_id,article_id,role) VALUES (${fact!.id},${sourceId(1)},'report')`;
    for (const [p, person] of inputs.entries()) await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at)
      VALUES(${story!.id},${sourceId(p)},${sourceId(p)},${sourceId(p)},${person.kind},${at})`;
    entries.push({ rank:i+1,storyId:story!.id,storyPublicId:story!.public_id,title:t,heat:10,trend:'flat',trendPct:0,badges:[],
      participantCount:12,sourceCount:8,signalCount:2,reportCount:5,sourceNames:inputs.map((_,n)=>name(n)),latestAt:at.toISOString(),firstReportAt:at.toISOString(),
      representativeItemId:null,representativeUrl:null,representativeSource:null,participants:inputs.map((p,n)=>({name:name(n),kind:p.kind,tier:p.tier})) });
  }
  const [saved] = await sql<{id:number}[]>`INSERT INTO hot_rankings(computed_at,rule_version,entries,published)
    VALUES(${at},'test',${sql.json(entries as never)},true) RETURNING id`;
  rankingId=saved!.id;
  const extras=await rankingExtras({id:rankingId,computedAt:at.toISOString(),ruleVersion:'test',entries,coverage:null});
  const full=extras.participants(entries[0]!);
  const home=(await loadHotStrip())![0]!.participants;

  // T1 (face first), T1.5, T2 (faces first, then stored order), then 氛围组 whatever its tier.
  const order=[5,2,3,1,6,8,9,7,0,4];
  assert.deepEqual(full.map(p=>p.name),order.map(name));
  assert.deepEqual(home,full,'home and /hot show the same faces');
  assert.deepEqual(full.map(p=>p.iconUrl),order.map(i=>proxiedImage(imageUrl(i),'avatar')),'every name keeps its icon for the tooltip');
  // The six visible faces get responsive images (T1 without avatar shows an initial); the seventh 精选组 face does not.
  assert.deepEqual(full.filter(p=>p.iconSrcSet).map(p=>p.name),[5,3,1,6,8].map(name));
});
