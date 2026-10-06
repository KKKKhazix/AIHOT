import { tag } from './setup.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { closeDb, sql } from '@aihot/backend/db';
import type { HotEntry } from '@aihot/backend/events/hot';
import { loadHotStrip, rankingExtras } from '@aihot/backend/publication/hot';
import { loadHot, v1HotTopics } from '@aihot/backend/publication/stories';

// Failure cases: names or participant counts disappear; a duplicate public name consumes a face slot;
// tier/real-image ordering changes; signal-group images leak into the payload; a missing image
// incorrectly frees a visible slot; /hot and home diverge; v1 changes.

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
after(closeDb);

test('faces are 精选组 sources by tier (T1, T1.5, T2), at most 6; 氛围组 only counts in +N', async () => {
  for (const [i, person] of inputs.entries()) {
    await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,icon_url,next_fetch_at)
      VALUES (${sourceId(i)},${name(i)},'rss',${person.tier},${person.kind === 'editorial' ? 'editorial' : 'hot_signal'},${imageUrl(i)},'2100-01-01')`;
    await sql`INSERT INTO articles (id,source_id,identity_key,url,title,discovered_at,timeline_at)
      VALUES(${sourceId(i)},${sourceId(i)},${sourceId(i)},${'https://example.org/'+sourceId(i)},${name(i)},now(),now())`;
  }
  const entries: HotEntry[] = [];
  const at = new Date('2099-01-01T00:00:00Z');
  for (let i=0;i<3;i++) {
    const [story] = await sql<{id:number;public_id:string}[]>`INSERT INTO stories(public_id,title) VALUES(${randomUUID()},${t}) RETURNING id,public_id`;
    const [fact] = await sql`INSERT INTO facts(public_id,story_id,title) VALUES(${randomUUID()},${story!.id},${t}) RETURNING id`;
    for (const [p, person] of inputs.entries()) if (person.kind === 'editorial') {
      await sql`INSERT INTO fact_articles(fact_id,article_id,role) VALUES(${fact!.id},${sourceId(p)},'report')`;
      await sql`INSERT INTO publications(article_id,source_id,title,url,timeline_at,discovered_at,sort_at,body_mode,eligible,channel)
        VALUES(${sourceId(p)},${sourceId(p)},${name(p)},${'https://example.org/'+sourceId(p)},${at},${at},${at},'summary',true,'news')
        ON CONFLICT(article_id) DO NOTHING`;
    }
    for (const [p, person] of inputs.entries()) await sql`INSERT INTO story_signals(story_id,article_id,participant_key,source_id,kind,observed_at)
      VALUES(${story!.id},${sourceId(p)},${sourceId(p)},${sourceId(p)},${person.kind},${at})`;
    entries.push({ rank:i+1,storyId:story!.id,storyPublicId:story!.public_id,title:t,heat:10,trend:'flat',trendPct:0,badges:[],
      participantCount:12,sourceCount:8,signalCount:2,reportCount:5,sourceNames:inputs.map((_,n)=>name(n)),latestAt:at.toISOString(),firstReportAt:at.toISOString(),
      representativeItemId:sourceId(1),representativeUrl:'https://example.org/'+sourceId(1),representativeSource:name(1),participants:[
        ...inputs.map((p,n)=>({name:name(n),kind:p.kind,tier:p.tier})),
        {name:`${name(5)}（another channel）`,kind:'editorial',tier:'T1'},
      ] });
  }
  const [saved] = await sql<{id:number}[]>`INSERT INTO hot_rankings(computed_at,rule_version,entries,published)
    VALUES(${at},'test',${sql.json(entries as never)},true) RETURNING id`;
  const ranking={id:saved!.id,computedAt:at.toISOString(),ruleVersion:'test',entries,coverage:null};
  const extras = await rankingExtras(ranking);
  const full=extras.participants(entries[0]!);
  const home=(await loadHotStrip())![0]!;
  const hot=(await loadHot()).entries[0]!;

  // T1 (face first), T1.5, T2 (faces first, then stored order), then 氛围组 whatever its tier.
  const order=[5,2,3,1,6,8,9,7,0,4];
  assert.deepEqual(full.map(p=>p.name),order.map(name));
  assert.deepEqual(home.participants,full,'home shows the same faces');
  assert.deepEqual(hot.participants,full,'/hot shows the same faces');
  assert.equal(home.participantCount,12,'the +N count still includes everyone');
  assert.equal(hot.participantCount,12);
  assert.deepEqual(full.slice(0,6).map(p=>p.iconUrl ? new URL(p.iconUrl, 'http://localhost').searchParams.get('u') : null),order.slice(0,6).map(imageUrl),'visible faces keep their image or initial');
  assert.equal(full[1]!.iconUrl,null,'a visible initial still takes one of the six slots');
  const signals=extras.participants({...entries[0]!,participants:entries[0]!.participants.filter(p=>p.kind==='signal')});
  assert.deepEqual(signals,order.filter(i=>inputs[i]!.kind==='signal').map(i=>({name:name(i),kind:'signal'})),'no editorial faces means no image URLs at all');
  const external=(await v1HotTopics()).items[0]!;
  assert.equal(external.participantCount,12);
  assert.deepEqual(external.sourceNames,entries[0]!.sourceNames,'machine clients keep every stored source name');
  assert.deepEqual(Object.keys(external).sort(),['rank','id','title','source','links','sourceCount','signalCount','participantCount','sourceNames','latestAt'].sort(),'the external hot-topic contract is unchanged');
});
