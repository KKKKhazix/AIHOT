import { randomUUID } from 'node:crypto';
import type { Database, Parameter, ProductInput, StudyInput, RecordInput, Session } from './contracts.ts';
import { ResearchImportConflict, ResearchValidationError } from './contracts.ts';
import { inputFingerprint, normalizeRecord, validateProduct, validateStudy } from './normalize.ts';

function execute<Row extends Record<string, unknown> = Record<string, unknown>>(db: Session, text: string, values: Parameter[] = []): Promise<Row[]> {
  return db.query<Row>({ text, values });
}
// postgres.js JSON-encodes object/array parameters for ::jsonb. Passing a
// pre-serialized string would store a JSON string instead of its contents.
const json = (value: unknown): Parameter => JSON.parse(JSON.stringify(value ?? {})) as Parameter;

/** Explicit admin/catalogue writes, not exposed to models or public readers. Insert-only. */
export async function saveProduct(db: Database, input: ProductInput): Promise<void> {
  validateProduct(input);
  await db.transaction(async tx => {
    const inserted = await execute(tx, `INSERT INTO ep_products (id,name,kind,parent_id)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
      [input.id, input.name, input.kind, input.parentId ?? null]);
    if (inserted.length) return;
    const [old] = await execute<{name:string;kind:string;parent_id:string|null}>(tx,
      'SELECT name,kind,parent_id FROM ep_products WHERE id=$1', [input.id]);
    if (!old || old.name !== input.name || old.kind !== input.kind || old.parent_id !== (input.parentId ?? null)) {
      throw new ResearchValidationError(`Product ${input.id} conflicts with existing catalogue data; review explicitly.`);
    }
  });
}
export async function saveStudy(db: Database, input: StudyInput): Promise<void> {
  validateStudy(input);
  await db.transaction(async tx => {
    const inserted = await execute(tx, `INSERT INTO ep_studies (id,name,registry_id,reported_counts)
      VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING id`,
      [input.id, input.name, input.registryId ?? null, json(input.reportedCounts ?? [])]);
    if (inserted.length) return;
    const [old] = await execute<{name:string;registry_id:string|null;reported_counts:unknown}>(tx,
      'SELECT name,registry_id,reported_counts FROM ep_studies WHERE id=$1', [input.id]);
    if (!old || old.name !== input.name || old.registry_id !== (input.registryId ?? null)
      || inputFingerprint(old.reported_counts) !== inputFingerprint(input.reportedCounts ?? [])) {
      throw new ResearchValidationError(`Study ${input.id} or registry ID conflicts with stored data; no automatic merge.`);
    }
  });
}

/** Same normalized input is idempotent. A changed DOI record is a review conflict, NOT
 * an implicit overwrite or a model job. All child inserts succeed or roll back together. */
export async function saveResearchRecord(db: Database, input: RecordInput): Promise<{id: string; created: boolean}> {
  const data = normalizeRecord(input);
  const hash = inputFingerprint(data);
  const identity = data.doi ? `doi:${data.doi}` : `source:${data.sourceKey}`;
  return db.transaction(async tx => {
    const recordId = randomUUID();
    const inserted = await execute<{id:string}>(tx, `INSERT INTO ep_research_records
      (id,identity_key,source_key,doi,article_id,title,source_url,published_on,study_design,
       material_scope,source_version,input_hash,publication_state,metadata_public_allowed,
       rights_basis,rights_expires_at,processing_meta,private_data)
      VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17::jsonb,$18::jsonb)
      ON CONFLICT DO NOTHING RETURNING id`,
      [recordId, identity, data.sourceKey, data.doi ?? null, data.articleId ?? null,
       data.title, data.sourceUrl, data.publishedOn ?? null, data.studyDesign,
       data.materialScope, data.sourceVersion, hash, data.publication.state,
       data.publication.metadataAllowed, data.publication.basis ?? null,
       data.publication.expiresAt ?? null, json(data.processingMeta), json(data.privateData)]);
    if (!inserted.length) {
      const existing = await execute<{id:string;input_hash:string}>(tx,
        `SELECT id,input_hash FROM ep_research_records
         WHERE identity_key=$1 OR source_key=$2 OR doi=$3 OR article_id=$4`,
        [identity, data.sourceKey, data.doi ?? null, data.articleId ?? null]);
      if (existing.length !== 1) throw new ResearchValidationError('Conflicting identity keys; no automatic record merge.');
      if (existing[0]!.input_hash !== hash) throw new ResearchImportConflict(existing[0]!.id);
      return { id: existing[0]!.id, created: false };
    }
    for (const link of data.studyLinks) await execute(tx,
      'INSERT INTO ep_record_studies (record_id,study_id,relation,source_locator) VALUES ($1::uuid,$2,$3,$4)',
      [recordId, link.studyId, link.relation, link.locator]);
    for (const arm of data.arms) {
      const armId = randomUUID();
      await execute(tx, `INSERT INTO ep_research_arms
        (id,record_id,arm_key,label,population,reported_n,n_unit,n_scope,evidence_private)
        VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [armId, recordId, arm.key, arm.label, arm.population, arm.reportedSample?.value ?? null,
         arm.reportedSample?.unit ?? null, arm.reportedSample?.scope ?? null, json(arm.evidencePrivate)]);
      for (const context of arm.contexts) {
        const contextId = randomUUID();
        await execute(tx, `INSERT INTO ep_research_contexts
          (id,record_id,arm_id,context_key,label,disease,imaging,imaging_purpose,radiation_strategy,
           source_locator,verified,public_allowed,evidence_private)
          VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,
            ARRAY(SELECT jsonb_array_elements_text($7::jsonb)),$8,$9,$10,$11,$12,$13::jsonb)`,
          [contextId, recordId, armId, context.key, context.label, context.disease ?? null,
           json(context.imaging), context.imagingPurpose ?? null, context.radiationStrategy,
           context.locator, context.verified, context.publicAllowed, json(context.evidencePrivate)]);
        for (const product of context.products) await execute(tx,
          'INSERT INTO ep_context_products (context_id,product_id,role,source_locator) VALUES ($1::uuid,$2,$3,$4)',
          [contextId, product.productId, product.role, product.locator]);
        for (const f of context.findings) await execute(tx, `INSERT INTO ep_research_findings
          (id,context_id,finding_key,endpoint,label,numerator,denominator,denominator_unit,denominator_scope,
           time_role,time_value,time_unit,time_basis,source_locator,verified,public_allowed,evidence_private)
          VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
          [randomUUID(), contextId, f.key, f.endpoint, f.label, f.numerator ?? null,
           f.denominator?.value ?? null, f.denominator?.unit ?? null, f.denominator?.scope ?? null,
           f.time?.role ?? 'unspecified', f.time?.value ?? null, f.time?.unit ?? null,
           f.time?.basis ?? 'unknown', f.locator, f.verified, f.publicAllowed, json(f.evidencePrivate)]);
      }
    }
    return { id: recordId, created: true };
  });
}

/** Removing public access never launches a model job; exact re-import cannot republish it. */
export async function withdrawResearchRecord(db: Database, id: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ResearchValidationError('Invalid record UUID.');
  const rows = await execute(db, `UPDATE ep_research_records SET publication_state='withdrawn'
    WHERE id=$1::uuid RETURNING id`, [id]);
  return rows.length === 1;
}
