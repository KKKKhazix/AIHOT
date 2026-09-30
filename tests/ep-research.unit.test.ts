import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeDoi, normalizeRecord, inputFingerprint, comparableDuration, validateProduct, validateStudy } from '../packages/backend/src/research/normalize.ts';
import { publicResearchStatement } from '../packages/backend/src/research/statements.ts';
import { getPublicResearch, listPublicResearch } from '../packages/backend/src/publication/research.ts';
import { saveResearchRecord } from '../packages/backend/src/research/repository.ts';
import { ResearchValidationError } from '../packages/backend/src/research/contracts.ts';
import type { Database, Session, RecordInput, Statement } from '../packages/backend/src/research/contracts.ts';
import { record, finding } from './fixtures/ep-research.ts';
import { assertEpTestDatabase } from './fixtures/ep-test-safety.ts';
const product = 'varipulse-test-catheter';
const fresh = (): RecordInput => record('synthetic-unit', product);
const bad = (change: (r: RecordInput) => void): void => { const r = fresh(); change(r); assert.throws(() => normalizeRecord(r), ResearchValidationError); };

test('DOI case and URL presentation normalize without accessing the network', () => {
  assert.equal(normalizeDoi(' HTTPS://DOI.ORG/10.9999/EP-PR1.ABC '), '10.9999/ep-pr1.abc');
  assert.equal(normalizeDoi('doi:10.9999/EP-PR1.ABC'), '10.9999/ep-pr1.abc');
  assert.equal(normalizeDoi(null), null);
});
test('DOI rejects whitespace and non-DOI strings', () => {
  for (const input of ['not-a-doi', '10.9999/bad value', 'https://evil.invalid/10.9999/test']) assert.throws(() => normalizeDoi(input));
});
test('independent case report has no required trial link', () => {
  const r = fresh(); r.studyDesign = 'case_report'; r.studyLinks = [];
  assert.deepEqual(normalizeRecord(r).studyLinks, []);
});
test('normalization neither mutates input nor fabricates a missing denominator', () => {
  const r = fresh(); r.arms[0]!.contexts[0]!.findings = [finding({ numerator: null, denominator: null })];
  const before = JSON.stringify(r); const out = normalizeRecord(r);
  assert.equal(out.arms[0]!.contexts[0]!.findings[0]!.denominator, null);
  assert.equal(JSON.stringify(r), before);
});
test('TEE and zero-fluoroscopy are separate, simultaneously valid dimensions', () => {
  const c = normalizeRecord(fresh()).arms[0]!.contexts[0]!;
  assert.deepEqual(c.imaging, ['TEE']); assert.equal(c.radiationStrategy, 'zero_fluoro');
});
test('zero-fluoroscopy cannot be submitted as an ultrasound modality', () => {
  bad(r => { r.arms[0]!.contexts[0]!.imaging = ['zero_fluoro' as never]; });
});
test('a strategy may have a non-100% completion proportion', () => {
  const r = fresh(); r.arms[0]!.contexts[0]!.findings = [finding({ key: 'zero-complete', endpoint: 'zero_fluoro_completed', numerator: 119, denominator: {value:121,unit:'patients',scope:'procedures evaluated'} })];
  const c = normalizeRecord(r).arms[0]!.contexts[0]!;
  assert.equal(c.radiationStrategy, 'zero_fluoro'); assert.equal(c.findings[0]!.numerator, 119); assert.equal(c.findings[0]!.denominator!.value, 121);
});
test('numerator never inherits the cohort denominator', () => {
  bad(r => { r.arms[0]!.contexts[0]!.findings[0]!.denominator = null; });
});
test('negative or excessive binary numerator fails', () => {
  bad(r => { r.arms[0]!.contexts[0]!.findings[0]!.numerator = -1; });
  bad(r => { r.arms[0]!.contexts[0]!.findings[0]!.numerator = 122; });
});
test('a denominator needs a unit and analysis population scope', () => {
  bad(r => { r.arms[0]!.contexts[0]!.findings[0]!.denominator!.scope = ''; });
});
test('calendar months and days are deliberately not silently interchangeable', () => {
  assert.deepEqual(comparableDuration(1,'year'), {family:'calendar_month',value:12});
  assert.deepEqual(comparableDuration(12,'month'), {family:'calendar_month',value:12});
  assert.deepEqual(comparableDuration(1,'week'), {family:'day',value:7});
  assert.notEqual(comparableDuration(365,'day').family, comparableDuration(1,'year').family);
});
test('enrollment time remains different from follow-up', () => {
  const r = fresh(); r.arms[0]!.contexts[0]!.findings.push(finding({ key:'enrollment', endpoint:'enrollment', time:{role:'enrollment_period',value:1,unit:'year',basis:'observed'} }));
  const out = normalizeRecord(r).arms[0]!.contexts[0]!.findings;
  assert.equal(out[0]!.time!.value,7); assert.equal(out[0]!.time!.role,'follow_up'); assert.equal(out[1]!.time!.role,'enrollment_period');
});
test('unverified findings and contexts cannot be released', () => {
  bad(r => { r.arms[0]!.contexts[0]!.verified = false; });
  bad(r => { r.arms[0]!.contexts[0]!.findings[0]!.verified = false; });
});
test('publication needs an explicit basis; private drafts are valid', () => {
  bad(r => { r.publication.basis = null; });
  const r = fresh(); r.publication = {state:'draft',metadataAllowed:false}; assert.doesNotThrow(() => normalizeRecord(r));
});
test('invalid calendar dates and timestamps fail', () => {
  bad(r => { r.publishedOn = '2026-02-30'; });
  bad(r => { r.publication.expiresAt = '2026-09-30T12:00:00'; });
});
test('unsafe source URL schemes or embedded credentials fail', () => {
  bad(r => { r.sourceUrl = 'javascript:alert(1)'; });
  bad(r => { r.sourceUrl = 'https://user:password@example.invalid/p'; });
});
test('unknown top-level and clinical fields fail rather than disappear silently', () => {
  bad(r => { (r as unknown as Record<string, unknown>).followup = 365; });
  bad(r => { (r.arms[0]!.contexts[0] as unknown as Record<string,unknown>).ice = true; });
});
test('duplicate local keys and products are rejected', () => {
  bad(r => { r.arms.push(structuredClone(r.arms[0]!)); });
  bad(r => { r.arms[0]!.contexts.push(structuredClone(r.arms[0]!.contexts[0]!)); });
  bad(r => { const p=r.arms[0]!.contexts[0]!.products; p.push(structuredClone(p[0]!)); });
});
test('oversized input fails before database access', () => {
  bad(r => { r.privateData = { text: 'x'.repeat(270_000) }; });
});
test('fingerprint is stable to object property order and retains processing versions', () => {
  assert.equal(inputFingerprint({a:1,b:2}), inputFingerprint({b:2,a:1}));
  const r = fresh(); const hash = inputFingerprint(r); r.processingMeta = {promptVersion:'v2'};
  assert.notEqual(inputFingerprint(r), hash);
});
test('catalogue represents a catheter and generator as different identities', () => {
  assert.doesNotThrow(() => validateProduct({id:'varipulse-test',name:'VARIPULSE (synthetic fixture)',kind:'catheter'}));
  assert.doesNotThrow(() => validateProduct({id:'trupulse-test',name:'TRUPULSE (synthetic fixture)',kind:'generator'}));
  assert.throws(() => validateProduct({id:'x',name:'x',kind:'catheter',parentId:'x'}));
});
test('study-level counts require their own scope, source and date', () => {
  assert.doesNotThrow(() => validateStudy({id:'test-study',name:'Synthetic',reportedCounts:[{value:500,scope:'planned enrollment',sourceRef:'synthetic registry',asOf:'2026-09-01'}]}));
  assert.throws(() => validateStudy({id:'test-study',name:'Synthetic',reportedCounts:[{value:500,scope:'',sourceRef:'synthetic registry',asOf:'2026-09-01'}]}));
});
test('query values use placeholders and never interpolate a product ID', () => {
  const q = publicResearchStatement({productId:product,imaging:'ICE',disease:'AF',minFollowUp:{value:1,unit:'year',basis:'observed'}});
  assert.ok(q.values.includes(product)); assert.ok(!q.text.includes(product)); assert.ok(q.values.includes(12));
  assert.match(q.text,/p\.context_id = c\.id/); assert.match(q.text,/f\.context_id = c\.id/);
});
test('endpoint and follow-up predicates are checked on the same finding alias', () => {
  const q = publicResearchStatement({endpoint:'safety_events',minFollowUp:{value:12,unit:'month',basis:'observed'}});
  assert.match(q.text,/f\.endpoint = \$\d+ AND f\.time_role = 'follow_up' AND f\.time_basis = \$\d+ AND f\.duration_family = \$\d+ AND f\.duration_value >= \$\d+/);
});
test('query reads only public projection views, not private base tables', () => {
  const q = publicResearchStatement({productId:product});
  const reads = [...q.text.matchAll(/(?:FROM|JOIN)\s+(\w+)/g)].map(m => m[1]);
  assert.ok(reads.every(name => name === 'page' || name!.startsWith('ep_public_')));
  for (const secret of ['private_data','evidence_private','processing_meta','reported_n','reported_counts']) assert.ok(!q.text.includes(secret));
});
test('SQL injection and unsupported filters are rejected at the boundary', () => {
  assert.throws(() => publicResearchStatement({productId:"x' OR true --"}));
  assert.throws(() => publicResearchStatement({imaging:'zero_fluoro' as never}));
  assert.throws(() => publicResearchStatement({limit:10000}));
  assert.throws(() => publicResearchStatement({minFollowUp:{value:12,unit:'month',basis:'unknown'}}));
});
test('pagination is keyset-based including undated records', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const dated = publicResearchStatement({cursor:{id,publishedOn:'2026-09-01'}});
  const undated = publicResearchStatement({cursor:{id,publishedOn:null}});
  assert.match(dated.text,/r\.published_on IS NULL/); assert.match(undated.text,/r\.published_on IS NULL AND r\.id </);
  assert.ok(!dated.text.includes('OFFSET')); assert.ok(!undated.text.includes('OFFSET'));
});
test('record-level index remains queryable with no extracted contexts', () => {
  const q = publicResearchStatement({studyDesign:'case_report'});
  const page = q.text.slice(0,q.text.indexOf('\n    SELECT r.id'));
  assert.ok(!page.includes('EXISTS')); assert.ok(q.values.includes('case_report'));
});
test('public read functions execute one bounded statement and do not generate content', async () => {
  const captured: Statement[] = [];
  const db: Session = { async query<Row extends Record<string,unknown>>(q:Statement) { captured.push(q); return [] as Row[]; } };
  assert.deepEqual(await listPublicResearch(db,{productId:product}),[]);
  assert.equal(await getPublicResearch(db,'00000000-0000-4000-8000-000000000001'),null);
  assert.equal(captured.length,2);
});
test('invalid import is rejected before opening a transaction', async () => {
  let calls = 0;
  const db: Database = { async query(){ calls++; return []; }, async transaction(){ calls++; throw new Error('unexpected transaction'); } };
  const r = fresh(); r.arms[0]!.contexts[0]!.imaging = ['zero_fluoro' as never];
  await assert.rejects(saveResearchRecord(db,r),ResearchValidationError); assert.equal(calls,0);
});
test('database test guard refuses missing URL and non-test database', () => {
  assert.throws(() => assertEpTestDatabase(undefined));
  assert.throws(() => assertEpTestDatabase('postgres://localhost/production'));
  assert.throws(() => assertEpTestDatabase('postgres://localhost/ep_prod'));
  assert.throws(() => assertEpTestDatabase('postgres://localhost/ep_test?database=production'));
  assert.throws(() => assertEpTestDatabase('postgres://localhost/ep_test#override'));
  assert.throws(() => assertEpTestDatabase('postgres://localhost/ep_test', {NODE_ENV:'production'}));
});
test('database guard allows dedicated local test DB and refuses enabled model calls', () => {
  const old = process.env.MODEL_CALLS_ENABLED; process.env.MODEL_CALLS_ENABLED = 'false';
  try {
    assert.doesNotThrow(() => assertEpTestDatabase('postgres://localhost/ep_pr1_test'));
    process.env.MODEL_CALLS_ENABLED = 'true'; assert.throws(() => assertEpTestDatabase('postgres://localhost/ep_pr1_test'));
  } finally { if (old === undefined) delete process.env.MODEL_CALLS_ENABLED; else process.env.MODEL_CALLS_ENABLED = old; }
});
test('migration is additive and contains no queue or model side effects (static check only)', () => {
  const sql = readFileSync(new URL('../database/migrations/0039_ep_research.sql',import.meta.url),'utf8');
  assert.ok(!/\b(?:DROP|TRUNCATE|ALTER\s+TABLE\s+articles|CREATE\s+TRIGGER)\b/i.test(sql));
  assert.match(sql,/FOREIGN KEY \(arm_id, record_id\)/); assert.match(sql,/CREATE VIEW ep_public_records/);
});
