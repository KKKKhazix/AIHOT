import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { assertEpTestDatabase } from './fixtures/ep-test-safety.ts';
import { record, arm, context, finding } from './fixtures/ep-research.ts';
import { saveResearchRecord, saveProduct, saveStudy, withdrawResearchRecord } from '../packages/backend/src/research/repository.ts';
import { getPublicResearch, listPublicResearch } from '../packages/backend/src/publication/research.ts';
import { publicResearchStatement } from '../packages/backend/src/research/statements.ts';
import { ResearchImportConflict } from '../packages/backend/src/research/contracts.ts';
import type { RecordInput } from '../packages/backend/src/research/contracts.ts';

// Fail loudly without PostgreSQL. No sqlite/array/mock fallback and no silent test.skip.
assertEpTestDatabase(process.env.DATABASE_URL);
if (process.env.NODE_ENV === 'production') throw new Error('Never run research fixtures in production.');
process.env.NODE_ENV ??= 'test';
process.env.MODEL_CALLS_ENABLED = 'false';
process.env.COLLECT_ENABLED = 'false';
process.env.INDEXNOW_SUBMIT_ENABLED = 'false';
for (const key of Object.keys(process.env)) if (/^FEISHU_.*_ENABLED$/.test(key)) process.env[key] = 'false';
const { sql, closeDb } = await import('../packages/backend/src/db.ts');
const { researchDatabase } = await import('../packages/backend/src/research/postgres.ts');
const db = researchDatabase(sql);
const run = `ep-pr1-${randomUUID().slice(0,8)}`;
const productA = `${run}-varipulse`, productB = `${run}-other`, studyId = `${run}-study`;
let setup = false;
let schemaReady = false;
const input = (name: string, overrides: Partial<RecordInput> = {}): RecordInput => record(`${run}:${name}`, productA, overrides);
const ids = (rows: {id: string}[]): string[] => rows.map(row => row.id);
const q = async <Row extends Record<string,unknown> = Record<string,unknown>>(text: string, values: (string|number|boolean|null)[] = []): Promise<Row[]> => db.query<Row>({text,values});
const errorCode = (expected: string) => (error: unknown): boolean => (error as {code?:string})?.code === expected;

before(async () => {
  const [info] = await q<{database:string;version:string;schema:string|null}>(`SELECT current_database() AS database,
    current_setting('server_version') AS version, to_regclass('ep_research_records')::text AS schema`);
  assert.ok(info && /_(test|ci)$/.test(info.database), 'Must be a real dedicated test DB');
  assert.ok(info.schema, 'Run the existing migration runner first, including 0039_ep_research.sql');
  schemaReady = true;
  await saveProduct(db,{id:productA,name:'[SYNTHETIC] VARIPULSE catheter',kind:'catheter'});
  await saveProduct(db,{id:productB,name:'[SYNTHETIC] other product',kind:'catheter'});
  await saveStudy(db,{id:studyId,name:'[SYNTHETIC] parent study',reportedCounts:[{value:500,scope:'planned enrollment only',sourceRef:'synthetic-registry',asOf:'2026-09-01'}]});
  setup = true;
});
after(async () => {
  try {
    if (!schemaReady) return;
    // Run-specific keys only; never TRUNCATE application tables or remove other test runs.
    await q('DELETE FROM ep_research_records WHERE source_key LIKE $1',[`${run}:%`]);
    await q('DELETE FROM ep_studies WHERE id=$1',[studyId]);
    await q('DELETE FROM ep_products WHERE id IN ($1,$2)',[productA,productB]);
  } finally { await closeDb(); }
});

test('PG: independent case report persists without registry or study', async () => {
  const r = await saveResearchRecord(db,input('case',{studyDesign:'case_report',arms:[]}));
  const card = await getPublicResearch(db,r.id);
  assert.equal(card?.study_design,'case_report'); assert.deepEqual(card?.matches,[]);
  const count = await q<{n:number}>('SELECT count(*)::int AS n FROM ep_record_studies WHERE record_id=$1::uuid',[r.id]);
  assert.equal(count[0]?.n,0);
});
test('PG: normalized DOI duplicate import creates exactly one record', async () => {
  const data = input('duplicate',{doi:`10.9999/${run}.Duplicate`});
  const first = await saveResearchRecord(db,data);
  const second = await saveResearchRecord(db,{...data,doi:`https://doi.org/10.9999/${run}.duplicate`});
  assert.equal(first.id,second.id); assert.equal(first.created,true); assert.equal(second.created,false);
  const [{n}] = await q<{n:number}>('SELECT count(*)::int AS n FROM ep_research_records WHERE doi=$1',[`10.9999/${run}.duplicate`]);
  assert.equal(n,1);
});
test('PG: storage-equivalent omissions and URL spellings reuse the imported row', async () => {
  const omitted = input('canonical',{sourceUrl:'HTTPS://EXAMPLE.INVALID/ep-pr1-fixture',publication:{state:'draft',metadataAllowed:false}});
  delete omitted.publishedOn;
  delete omitted.processingMeta;
  delete omitted.privateData;
  const a = omitted.arms[0]!;
  delete a.reportedSample;
  delete a.evidencePrivate;
  const c = a.contexts[0]!;
  delete c.disease;
  delete c.imagingPurpose;
  delete c.evidencePrivate;
  const f = c.findings[0]!;
  delete f.numerator;
  delete f.denominator;
  delete f.time;
  delete f.evidencePrivate;

  const explicit = structuredClone(omitted);
  explicit.sourceUrl = 'https://example.invalid/ep-pr1-fixture';
  explicit.doi = null;
  explicit.articleId = null;
  explicit.publishedOn = null;
  explicit.processingMeta = {};
  explicit.privateData = {};
  explicit.publication.basis = null;
  explicit.publication.expiresAt = null;
  const ea = explicit.arms[0]!;
  ea.reportedSample = null;
  ea.evidencePrivate = {};
  const ec = ea.contexts[0]!;
  ec.disease = null;
  ec.imagingPurpose = null;
  ec.evidencePrivate = {};
  const ef = ec.findings[0]!;
  ef.numerator = null;
  ef.denominator = null;
  ef.time = null;
  ef.evidencePrivate = {};

  const first = await saveResearchRecord(db,omitted);
  const second = await saveResearchRecord(db,explicit);
  assert.equal(second.id,first.id);
  assert.equal(second.created,false);
  const [saved] = await q<{source_url:string}>('SELECT source_url FROM ep_research_records WHERE id=$1::uuid',[first.id]);
  assert.equal(saved?.source_url,'https://example.invalid/ep-pr1-fixture');
});
test('PG: concurrent identical imports have one winner without duplicate child rows', async () => {
  const data = input('concurrent',{doi:`10.9999/${run}.concurrent`});
  const result = await Promise.all([saveResearchRecord(db,data),saveResearchRecord(db,data)]);
  assert.equal(new Set(ids(result)).size,1); assert.equal(result.filter(x=>x.created).length,1);
  const [{n}] = await q<{n:number}>('SELECT count(*)::int AS n FROM ep_research_arms WHERE record_id=$1::uuid',[result[0]!.id]);
  assert.equal(n,1);
});
test('PG: changed content does not overwrite an existing DOI record', async () => {
  const data = input('conflict',{doi:`10.9999/${run}.conflict`});
  const saved = await saveResearchRecord(db,data);
  await assert.rejects(saveResearchRecord(db,{...data,title:'changed title'}),ResearchImportConflict);
  assert.equal((await getPublicResearch(db,saved.id))?.title,data.title);
});
test('PG: version-only change does not overwrite data or trigger any reprocessing', async () => {
  const data = input('version'); const saved = await saveResearchRecord(db,data);
  await assert.rejects(saveResearchRecord(db,{...data,processingMeta:{promptVersion:'v2'}}),ResearchImportConflict);
  const [row] = await q<{processing_meta:{promptVersion:string}}>('SELECT processing_meta FROM ep_research_records WHERE id=$1::uuid',[saved.id]);
  assert.equal(row!.processing_meta.promptVersion,'test-only-v1');
  // There is no queue dependency/import or trigger in PR1; this verifies the persisted result only.
});
test('PG: cross-arm product / imaging / follow-up conjunction never matches', async () => {
  const data = input('cross-arm',{arms:[
    arm(productA),
    arm(productB,{key:'b',label:'[SYNTHETIC] B',contexts:[context(productB,{imaging:['ICE'],findings:[finding({time:{role:'follow_up',value:12,unit:'month',basis:'observed'}})]})]})
  ]});
  const saved = await saveResearchRecord(db,data);
  const wrong = await listPublicResearch(db,{productId:productA,imaging:'ICE',minFollowUp:{value:12,unit:'month',basis:'observed'}});
  assert.ok(!ids(wrong).includes(saved.id));
  const right = await listPublicResearch(db,{productId:productA,imaging:'TEE',minFollowUp:{value:7,unit:'day',basis:'observed'}});
  assert.ok(ids(right).includes(saved.id));
});
test('PG: different procedural contexts inside the same arm cannot be flattened', async () => {
  const data = input('cross-context',{arms:[arm(productA,{contexts:[
    context(productA,{key:'first'}),
    context(productB,{key:'second',imaging:['ICE'],findings:[finding({time:{role:'follow_up',value:12,unit:'month',basis:'observed'}})]})
  ]})]});
  const saved = await saveResearchRecord(db,data);
  const rows = await listPublicResearch(db,{productId:productA,imaging:'ICE',minFollowUp:{value:12,unit:'month',basis:'observed'}});
  assert.ok(!ids(rows).includes(saved.id));
});
test('PG: an acute safety result is not promoted to a long-term safety result', async () => {
  const data = input('cross-endpoint');
  data.arms[0]!.contexts[0]!.findings.push(finding({key:'recurrence',endpoint:'arrhythmia_recurrence',time:{role:'follow_up',value:12,unit:'month',basis:'observed'}}));
  const saved = await saveResearchRecord(db,data);
  const wrong = await listPublicResearch(db,{productId:productA,endpoint:'safety_events',minFollowUp:{value:12,unit:'month',basis:'observed'}});
  assert.ok(!ids(wrong).includes(saved.id));
  const right = await listPublicResearch(db,{productId:productA,endpoint:'arrhythmia_recurrence',minFollowUp:{value:1,unit:'year',basis:'observed'}});
  assert.ok(ids(right).includes(saved.id));
});
test('PG: planned follow-up and enrollment duration do not satisfy observed follow-up', async () => {
  const data = input('time-basis');
  data.arms[0]!.contexts[0]!.findings = [
    finding({key:'planned',time:{role:'follow_up',value:12,unit:'month',basis:'planned'}}),
    finding({key:'enrollment',time:{role:'enrollment_period',value:1,unit:'year',basis:'observed'}})
  ];
  const saved = await saveResearchRecord(db,data);
  assert.ok(!ids(await listPublicResearch(db,{productId:productA,minFollowUp:{value:12,unit:'month',basis:'observed'}})).includes(saved.id));
});
test('PG: a parent count of 500 never replaces a subgroup denominator of 24', async () => {
  const data = input('denominator',{studyLinks:[{studyId,relation:'secondary_report',locator:'synthetic-study-link'}]});
  data.arms[0]!.reportedSample = {value:121,unit:'patients',scope:'enrollment in report'};
  data.arms[0]!.contexts[0]!.findings = [finding({numerator:3,denominator:{value:24,unit:'patients',scope:'patients with this examination'}}),finding({key:'unreported',numerator:null,denominator:null})];
  const saved = await saveResearchRecord(db,data);
  const result = await getPublicResearch(db,saved.id);
  const findings = result!.matches.flatMap(c => c.findings as {denominator:number|null}[]);
  assert.deepEqual(findings.map(f=>f.denominator).sort((a,b)=>(a??-1)-(b??-1)),[null,24]);
  assert.ok(!JSON.stringify(result).includes('500'));
});
test('PG: zero-fluoro strategy and 119/121 completion are both preserved', async () => {
  const data = input('zero-fraction');
  data.arms[0]!.contexts[0]!.findings = [finding({key:'zero',endpoint:'zero_fluoro_completed',numerator:119,denominator:{value:121,unit:'patients',scope:'procedures assessed'},time:{role:'procedure',value:0,unit:'day',basis:'observed'}})];
  const saved = await saveResearchRecord(db,data); const result = await getPublicResearch(db,saved.id);
  assert.equal(result!.matches[0]!.radiationStrategy,'zero_fluoro');
  const [f] = result!.matches[0]!.findings as {numerator:number;denominator:number}[];
  assert.equal(f!.numerator,119); assert.equal(f!.denominator,121);
});
test('PG: restricted finding is absent and cannot be inferred through filtering', async () => {
  const data = input('private-finding');
  data.arms[0]!.contexts[0]!.findings.push(finding({key:'restricted',endpoint:'private_endpoint',publicAllowed:false,time:{role:'follow_up',value:12,unit:'month',basis:'observed'}}));
  const saved = await saveResearchRecord(db,data); const result = await getPublicResearch(db,saved.id);
  assert.ok(!JSON.stringify(result).includes('private_endpoint'));
  assert.ok(!ids(await listPublicResearch(db,{productId:productA,endpoint:'private_endpoint'})).includes(saved.id));
});
test('PG: private context cannot leak through imaging/product filtering', async () => {
  const data = input('private-context');
  data.arms[0]!.contexts.push(context(productB,{key:'secret',imaging:['ICE'],publicAllowed:false}));
  const saved = await saveResearchRecord(db,data); const result = await getPublicResearch(db,saved.id);
  assert.equal(result!.matches.length,1);
  assert.ok(!ids(await listPublicResearch(db,{productId:productB,imaging:'ICE'})).includes(saved.id));
});
test('PG: private, expired and revoked records are absent from all research reads', async () => {
  const privateId = await saveResearchRecord(db,input('private',{publication:{state:'draft',metadataAllowed:false}}));
  const expired = await saveResearchRecord(db,input('expired',{publication:{state:'published',metadataAllowed:true,basis:'synthetic fixture',expiresAt:'2000-01-01T00:00:00Z'}}));
  const data = input('revoked'); const revoked = await saveResearchRecord(db,data);
  await withdrawResearchRecord(db,revoked.id);
  const same = await saveResearchRecord(db,data); assert.equal(same.created,false);
  for (const row of [privateId,expired,revoked]) assert.equal(await getPublicResearch(db,row.id),null);
});
test('PG: public card never serializes internal text, arm counts or processing metadata', async () => {
  const saved = await saveResearchRecord(db,input('whitelist')); const result = await getPublicResearch(db,saved.id);
  const serialized = JSON.stringify(result);
  for (const word of ['PRIVATE_','promptVersion','processing_meta','reported_n','rights_basis']) assert.ok(!serialized.includes(word),word);
});
test('PG: broken product reference rolls back parent and all child inserts', async () => {
  const data = input('rollback'); data.arms[0]!.contexts[0]!.products[0]!.productId = `${run}-missing`;
  await assert.rejects(saveResearchRecord(db,data),errorCode('23503'));
  const [{n}] = await q<{n:number}>('SELECT count(*)::int AS n FROM ep_research_records WHERE source_key=$1',[data.sourceKey]); assert.equal(n,0);
});
test('PG: composite foreign key rejects a context assigned to another records arm', async () => {
  const a = await saveResearchRecord(db,input('fk-a')); const b = await saveResearchRecord(db,input('fk-b'));
  const [armRow] = await q<{id:string}>('SELECT id FROM ep_research_arms WHERE record_id=$1::uuid',[a.id]);
  await assert.rejects(q(`INSERT INTO ep_research_contexts (id,record_id,arm_id,context_key,label,source_locator)
    VALUES ($1::uuid,$2::uuid,$3::uuid,'bad','bad','synthetic')`,[randomUUID(),b.id,armRow!.id]),errorCode('23503'));
});
test('PG: database constraints independently reject invalid modality and denominator', async () => {
  const saved = await saveResearchRecord(db,input('db-checks'));
  const [c] = await q<{id:string}>('SELECT id FROM ep_research_contexts WHERE record_id=$1::uuid',[saved.id]);
  await assert.rejects(q(`UPDATE ep_research_contexts SET imaging=ARRAY['zero_fluoro']::text[] WHERE id=$1::uuid`,[c!.id]),errorCode('23514'));
  await assert.rejects(q(`UPDATE ep_research_findings SET numerator=999 WHERE context_id=$1::uuid`,[c!.id]),errorCode('23514'));
});
test('PG: hostile text remains data, not an executable SQL fragment', async () => {
  const data = input('sql-injection',{title:"[SYNTHETIC] '); DROP TABLE ep_products; --"});
  const saved = await saveResearchRecord(db,data); assert.equal((await getPublicResearch(db,saved.id))!.title,data.title);
  const [{n}] = await q<{n:number}>('SELECT count(*)::int AS n FROM ep_products WHERE id=$1',[productA]); assert.equal(n,1);
});
test('PG: dated and undated records paginate without duplicates or omissions', async () => {
  const saved: string[]=[];
  for (const [i,date] of ['2026-09-03','2026-09-03','2026-09-01',null,null].entries()) {
    const r = input(`page-${i}`,{publishedOn:date,studyDesign:'technical'});
    saved.push((await saveResearchRecord(db,r)).id);
  }
  let cursor: {publishedOn:string|null;id:string}|undefined; const seen:string[]=[];
  for (let i=0;i<10;i++) {
    const rows=await listPublicResearch(db,{productId:productA,studyDesign:'technical',limit:2,...(cursor?{cursor}:{})});
    if(!rows.length)break;
    seen.push(...ids(rows)); const last=rows.at(-1)!; cursor={publishedOn:last.published_on,id:last.id};
  }
  assert.equal(new Set(seen).size,seen.length); for(const id of saved)assert.ok(seen.includes(id));
});
test('PG: capture real query plan without pretending a small fixture is a load test', async () => {
  assert.ok(setup);
  const statement=publicResearchStatement({productId:productA,imaging:'TEE',endpoint:'safety_events',minFollowUp:{value:7,unit:'day',basis:'observed'}});
  const plan=await db.query({text:`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,values:statement.values});
  assert.ok(plan.length>0);
  if(process.env.EP_PR1_REPORT_DIR) {
    const dir=path.resolve(process.env.EP_PR1_REPORT_DIR); mkdirSync(dir,{recursive:true});
    writeFileSync(path.join(dir,'ep-pr1-explain.json'),JSON.stringify({kind:'small-fixture-query-plan-not-load-test',plan},null,2));
  }
});
