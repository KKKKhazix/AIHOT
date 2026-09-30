import { createHash } from 'node:crypto';
import { ResearchValidationError } from './contracts.ts';
import type { RecordInput, SearchFilter, ProductInput, StudyInput, TimeUnit } from './contracts.ts';

const designs = ['randomized','prospective','retrospective','case_report','case_series','technical','preclinical','review','unknown'];
const populations = ['human','animal','bench','simulation','mixed','unknown'];
const imaging = ['ICE','TEE','TTE','OTHER'];
const radiation = ['zero_fluoro','low_fluoro','unspecified'];
const units = ['patients','animals','lesions','veins','samples','other'];
const timeUnits = ['day','week','month','year'];
const timeBases = ['observed','planned','median','minimum','maximum','unknown'];
const slug = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(path: string, reason: string): never { throw new ResearchValidationError(`${path}: ${reason}`); }
function obj(value: unknown, path: string, allowed?: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object');
  const result = value as Record<string, unknown>;
  if (allowed) for (const key of Object.keys(result)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'unknown field');
  return result;
}
function text(value: unknown, path: string, max = 2000): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0')) fail(path, `expected nonempty text <= ${max} characters`);
}
function optionalText(value: unknown, path: string, max = 2000): void { if (value != null) text(value, path, max); }
function choice(value: unknown, choices: string[], path: string): void { if (typeof value !== 'string' || !choices.includes(value)) fail(path, 'unsupported value'); }
function bool(value: unknown, path: string): void { if (typeof value !== 'boolean') fail(path, 'expected boolean'); }
function number(value: unknown, path: string, integer = true, min = 0): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > 2_147_483_647 || (integer && !Number.isInteger(value))) fail(path, 'invalid nonnegative finite number');
}
function list(value: unknown, path: string, max = 200): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path, `expected array of at most ${max} items`);
  return value;
}
function id(value: unknown, path: string): void { if (typeof value !== 'string' || !slug.test(value)) fail(path, 'invalid product ID'); }
function key(value: unknown, path: string): void { text(value, path, 80); }
function unique(items: unknown[], field: string, path: string): void {
  const values = items.map((item, i) => obj(item, `${path}[${i}]`)[field]);
  if (new Set(values).size !== values.length) fail(path, `duplicate ${field}`);
}
function jsonObject(value: unknown, path: string): void { if (value != null) obj(value, path); }
function date(value: unknown, path: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(path, 'expected YYYY-MM-DD');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(path, 'invalid calendar date');
}
function count(value: unknown, path: string): void {
  const x = obj(value, path, ['value','unit','scope']);
  number(x.value, `${path}.value`); choice(x.unit, units, `${path}.unit`); text(x.scope, `${path}.scope`, 400);
}
function timestamp(value: unknown, path: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail(path, 'expected timestamp with timezone');
  date(value.slice(0, 10), path);
}

export function normalizeDoi(value?: string | null): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') fail('doi', 'expected string');
  const result = value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
  if (!/^10\.\d{4,9}\/\S+$/.test(result) || result.includes('\0') || result.length > 1000) fail('doi', 'invalid DOI syntax');
  return result;
}

export function normalizeRecord(input: RecordInput): RecordInput {
  // A bounded, JSON-only boundary: no executable values, cyclic input or oversized payloads.
  let serialized: string;
  try { serialized = JSON.stringify(input); } catch { fail('record', 'must be JSON serializable'); }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized) > 262_144) fail('record', 'payload exceeds 256 KiB');
  const r = obj(input, 'record', ['sourceKey','doi','articleId','title','sourceUrl','publishedOn','studyDesign','materialScope','sourceVersion','publication','studyLinks','processingMeta','privateData','arms']);
  text(r.sourceKey, 'sourceKey', 1000); text(r.title, 'title'); text(r.sourceUrl, 'sourceUrl', 2000);
  let url: URL;
  try { url = new URL(r.sourceUrl as string); } catch { fail('sourceUrl', 'invalid URL'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) fail('sourceUrl', 'only HTTP(S) without credentials is allowed');
  if (r.articleId != null && (typeof r.articleId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(r.articleId))) fail('articleId', 'invalid article ID');
  if (r.publishedOn != null) date(r.publishedOn, 'publishedOn');
  choice(r.studyDesign, designs, 'studyDesign'); choice(r.materialScope, ['metadata','abstract','partial_fulltext','fulltext'], 'materialScope');
  text(r.sourceVersion, 'sourceVersion', 200);
  jsonObject(r.processingMeta, 'processingMeta'); jsonObject(r.privateData, 'privateData');
  const pub = obj(r.publication, 'publication', ['state','metadataAllowed','basis','expiresAt']);
  choice(pub.state, ['draft','published','withdrawn'], 'publication.state'); bool(pub.metadataAllowed, 'publication.metadataAllowed');
  optionalText(pub.basis, 'publication.basis', 2000);
  if (pub.metadataAllowed && !pub.basis) fail('publication.basis', 'explicit permission basis is required');
  if (pub.expiresAt != null) timestamp(pub.expiresAt, 'publication.expiresAt');
  const links = list(r.studyLinks, 'studyLinks', 100); unique(links, 'studyId', 'studyLinks');
  for (const [i, item] of links.entries()) {
    const x = obj(item, `studyLinks[${i}]`, ['studyId','relation','locator']);
    if (typeof x.studyId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(x.studyId)) fail('studyId', 'invalid ID');
    choice(x.relation, ['primary_report','secondary_report','pooled_analysis','other'], 'study relation'); text(x.locator, 'study locator', 500);
  }
  const arms = list(r.arms, 'arms', 100); unique(arms, 'key', 'arms');
  for (const [ai, item] of arms.entries()) {
    const ap = `arms[${ai}]`; const a = obj(item, ap, ['key','label','population','reportedSample','evidencePrivate','contexts']);
    key(a.key, `${ap}.key`); text(a.label, `${ap}.label`, 400); choice(a.population, populations, `${ap}.population`);
    if (a.reportedSample != null) count(a.reportedSample, `${ap}.reportedSample`);
    jsonObject(a.evidencePrivate, `${ap}.evidencePrivate`);
    const contexts = list(a.contexts, `${ap}.contexts`, 100); unique(contexts, 'key', `${ap}.contexts`);
    for (const [ci, context] of contexts.entries()) {
      const cp = `${ap}.contexts[${ci}]`;
      const c = obj(context, cp, ['key','label','disease','imaging','imagingPurpose','radiationStrategy','products','locator','verified','publicAllowed','evidencePrivate','findings']);
      key(c.key, `${cp}.key`); text(c.label, `${cp}.label`, 400);
      if (c.disease != null && (typeof c.disease !== 'string' || !/^[A-Z][A-Z0-9_]{0,49}$/.test(c.disease))) fail(`${cp}.disease`, 'expected controlled code');
      const modes = list(c.imaging, `${cp}.imaging`, 4); for (const mode of modes) choice(mode, imaging, `${cp}.imaging`);
      if (new Set(modes).size !== modes.length) fail(`${cp}.imaging`, 'duplicate modality');
      optionalText(c.imagingPurpose, `${cp}.imagingPurpose`, 1000); choice(c.radiationStrategy, radiation, `${cp}.radiationStrategy`);
      text(c.locator, `${cp}.locator`, 500); bool(c.verified, `${cp}.verified`); bool(c.publicAllowed, `${cp}.publicAllowed`);
      if (c.publicAllowed && !c.verified) fail(cp, 'unverified context cannot be public');
      jsonObject(c.evidencePrivate, `${cp}.evidencePrivate`);
      const products = list(c.products, `${cp}.products`, 30); unique(products, 'productId', `${cp}.products`);
      for (const product of products) {
        const p = obj(product, `${cp}.product`, ['productId','role','locator']); id(p.productId, 'productId');
        choice(p.role, ['evaluated','used_as_tool','incidental_use'], 'product role'); text(p.locator, 'product locator', 500);
      }
      const findings = list(c.findings, `${cp}.findings`, 200); unique(findings, 'key', `${cp}.findings`);
      for (const [fi, finding] of findings.entries()) {
        const fp = `${cp}.findings[${fi}]`;
        const f = obj(finding, fp, ['key','endpoint','label','numerator','denominator','time','locator','verified','publicAllowed','evidencePrivate']);
        key(f.key, `${fp}.key`); text(f.label, `${fp}.label`, 2000);
        if (typeof f.endpoint !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(f.endpoint)) fail(`${fp}.endpoint`, 'invalid endpoint code');
        if (f.denominator != null) { count(f.denominator, `${fp}.denominator`); if ((f.denominator as {value:number}).value === 0) fail(fp, 'denominator must be positive'); }
        if (f.numerator != null) {
          number(f.numerator, `${fp}.numerator`);
          if (f.denominator == null || (f.numerator as number) > (f.denominator as {value:number}).value) fail(fp, 'numerator requires its own adequate denominator');
        }
        if (f.time != null) {
          const t = obj(f.time, `${fp}.time`, ['role','value','unit','basis']);
          choice(t.role, ['follow_up','enrollment_period','procedure','unspecified'], `${fp}.time.role`);
          number(t.value, `${fp}.time.value`, false); choice(t.unit, timeUnits, `${fp}.time.unit`); choice(t.basis, timeBases, `${fp}.time.basis`);
        }
        text(f.locator, `${fp}.locator`, 500); bool(f.verified, `${fp}.verified`); bool(f.publicAllowed, `${fp}.publicAllowed`);
        if (f.publicAllowed && !f.verified) fail(fp, 'unverified finding cannot be public');
        jsonObject(f.evidencePrivate, `${fp}.evidencePrivate`);
      }
    }
  }
  const result = JSON.parse(serialized) as RecordInput;
  result.doi = normalizeDoi(input.doi);
  result.sourceKey = result.sourceKey.trim();
  // Hash the same values that the repository writes. An omitted optional field
  // and its explicit SQL default must not turn an exact retry into a conflict.
  result.sourceUrl = url.href;
  text(result.sourceUrl, 'sourceUrl', 2000);
  result.articleId ??= null;
  result.publishedOn ??= null;
  result.processingMeta ??= {};
  result.privateData ??= {};
  result.publication.basis ??= null;
  result.publication.expiresAt ??= null;
  for (const arm of result.arms) {
    arm.reportedSample ??= null;
    arm.evidencePrivate ??= {};
    for (const context of arm.contexts) {
      context.disease ??= null;
      context.imagingPurpose ??= null;
      context.evidencePrivate ??= {};
      for (const finding of context.findings) {
        finding.numerator ??= null;
        finding.denominator ??= null;
        finding.time ??= null;
        finding.evidencePrivate ??= {};
      }
    }
  }
  return result;
}

export function validateProduct(p: ProductInput): void {
  obj(p, 'product', ['id','name','kind','parentId']); id(p.id, 'product.id'); text(p.name, 'product.name', 200);
  choice(p.kind, ['platform','catheter','generator','mapping_system','imaging','other'], 'product.kind');
  if (p.parentId != null) { id(p.parentId, 'product.parentId'); if (p.parentId === p.id) fail('product.parentId', 'cannot reference self'); }
}
export function validateStudy(s: StudyInput): void {
  obj(s, 'study', ['id','name','registryId','reportedCounts']);
  if (typeof s.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(s.id)) fail('study.id', 'invalid ID');
  text(s.name, 'study.name', 400); optionalText(s.registryId, 'study.registryId', 200);
  for (const item of list(s.reportedCounts ?? [], 'study.reportedCounts', 100)) {
    const x = obj(item, 'reportedCount', ['value','scope','sourceRef','asOf']);
    number(x.value, 'reportedCount.value'); text(x.scope, 'reportedCount.scope', 400); text(x.sourceRef, 'reportedCount.sourceRef', 1000); date(x.asOf, 'reportedCount.asOf');
  }
}
export function comparableDuration(value: number, unit: TimeUnit): { family: 'day' | 'calendar_month'; value: number } {
  number(value, 'duration.value', false); choice(unit, timeUnits, 'duration.unit');
  return unit === 'day' || unit === 'week'
    ? { family: 'day', value: value * (unit === 'week' ? 7 : 1) }
    : { family: 'calendar_month', value: value * (unit === 'year' ? 12 : 1) };
}
export function validateSearch(f: SearchFilter & { recordId?: string }): void {
  obj(f, 'filter', ['recordId','productId','disease','imaging','radiationStrategy','population','studyDesign','endpoint','minFollowUp','limit','cursor']);
  if (f.recordId != null && !uuid.test(f.recordId)) fail('recordId', 'invalid UUID');
  if (f.productId != null) id(f.productId, 'productId');
  if (f.disease != null && !/^[A-Z][A-Z0-9_]{0,49}$/.test(f.disease)) fail('disease', 'invalid controlled code');
  if (f.imaging != null) choice(f.imaging, imaging, 'imaging');
  if (f.radiationStrategy != null) choice(f.radiationStrategy, radiation, 'radiationStrategy');
  if (f.population != null) choice(f.population, populations, 'population');
  if (f.studyDesign != null) choice(f.studyDesign, designs, 'studyDesign');
  if (f.endpoint != null && !/^[a-z][a-z0-9_]{0,79}$/.test(f.endpoint)) fail('endpoint', 'invalid endpoint code');
  if (f.minFollowUp != null) {
    obj(f.minFollowUp, 'minFollowUp', ['value','unit','basis']); comparableDuration(f.minFollowUp.value, f.minFollowUp.unit);
    choice(f.minFollowUp.basis, timeBases.filter(x => x !== 'unknown'), 'minFollowUp.basis');
  }
  if (f.limit != null && (!Number.isInteger(f.limit) || f.limit < 1 || f.limit > 100)) fail('limit', 'must be 1..100');
  if (f.cursor != null) {
    obj(f.cursor, 'cursor', ['publishedOn','id']);
    if (typeof f.cursor.id !== 'string' || !uuid.test(f.cursor.id)) fail('cursor.id', 'invalid UUID');
    if (f.cursor.publishedOn !== null) date(f.cursor.publishedOn, 'cursor.publishedOn');
  }
}
export function inputFingerprint(value: unknown): string {
  function stable(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable((v as Record<string, unknown>)[k])]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
