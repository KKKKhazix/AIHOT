import type { Parameter, Statement, SearchFilter } from './contracts.ts';
import { comparableDuration, validateSearch } from './normalize.ts';

/** Public filters can only see released fields. All predicates share a context alias;
 * endpoint + follow-up share a finding alias. User values are NEVER SQL fragments. */
export function publicResearchStatement(filter: SearchFilter & { recordId?: string } = {}): Statement {
  validateSearch(filter);
  const values: Parameter[] = [];
  const bind = (value: Parameter): string => { values.push(value); return `$${values.length}`; };
  const record: string[] = [];
  const context: string[] = [];
  const finding: string[] = [];
  if (filter.recordId) record.push(`r.id = ${bind(filter.recordId)}::uuid`);
  if (filter.studyDesign) record.push(`r.study_design = ${bind(filter.studyDesign)}`);
  if (filter.productId) context.push(`EXISTS (SELECT 1 FROM ep_public_context_products p WHERE p.context_id = c.id AND p.product_id = ${bind(filter.productId)})`);
  if (filter.disease) context.push(`c.disease = ${bind(filter.disease)}`);
  if (filter.imaging) context.push(`c.imaging @> ARRAY[${bind(filter.imaging)}]::text[]`);
  if (filter.radiationStrategy) context.push(`c.radiation_strategy = ${bind(filter.radiationStrategy)}`);
  if (filter.population) context.push(`c.population = ${bind(filter.population)}`);
  if (filter.endpoint) finding.push(`f.endpoint = ${bind(filter.endpoint)}`);
  if (filter.minFollowUp) {
    const duration = comparableDuration(filter.minFollowUp.value, filter.minFollowUp.unit);
    finding.push(`f.time_role = 'follow_up'`, `f.time_basis = ${bind(filter.minFollowUp.basis)}`,
      `f.duration_family = ${bind(duration.family)}`, `f.duration_value >= ${bind(duration.value)}`);
  }
  const findingWhere = finding.length ? ` AND ${finding.join(' AND ')}` : '';
  if (finding.length) context.push(`EXISTS (SELECT 1 FROM ep_public_findings f WHERE f.context_id = c.id${findingWhere})`);
  const contextWhere = context.length ? ` AND ${context.join(' AND ')}` : '';
  if (context.length) record.push(`EXISTS (SELECT 1 FROM ep_public_contexts c WHERE c.record_id = r.id${contextWhere})`);
  if (filter.cursor) {
    const cursorId = bind(filter.cursor.id);
    if (filter.cursor.publishedOn === null) record.push(`(r.published_on IS NULL AND r.id < ${cursorId}::uuid)`);
    else {
      const published = bind(filter.cursor.publishedOn);
      record.push(`(r.published_on < ${published}::date OR (r.published_on = ${published}::date AND r.id < ${cursorId}::uuid) OR r.published_on IS NULL)`);
    }
  }
  const limit = bind(filter.limit ?? 25);
  return {
    text: `WITH page AS (
      SELECT r.id, r.doi, r.title, r.source_url, r.published_on, r.study_design, r.material_scope
      FROM ep_public_records r
      ${record.length ? `WHERE ${record.join(' AND ')}` : ''}
      ORDER BY r.published_on DESC NULLS LAST, r.id DESC LIMIT ${limit}
    )
    SELECT r.id, r.doi, r.title, r.source_url, to_char(r.published_on, 'YYYY-MM-DD') AS published_on,
      r.study_design, r.material_scope,
      COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'contextId', c.id, 'armId', c.arm_id, 'armLabel', c.arm_label, 'label', c.label,
        'population', c.population, 'disease', c.disease, 'imaging', c.imaging,
        'imagingPurpose', c.imaging_purpose, 'radiationStrategy', c.radiation_strategy,
        'sourceLocator', c.source_locator,
        'products', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', p.product_id, 'name', p.product_name, 'kind', p.product_kind, 'role', p.role
        ) ORDER BY p.product_id) FROM ep_public_context_products p WHERE p.context_id = c.id), '[]'::jsonb),
        'findings', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', f.id, 'endpoint', f.endpoint, 'label', f.label,
          'numerator', f.numerator, 'denominator', f.denominator,
          'denominatorUnit', f.denominator_unit, 'denominatorScope', f.denominator_scope,
          'timeRole', f.time_role, 'timeValue', f.time_value, 'timeUnit', f.time_unit,
          'timeBasis', f.time_basis, 'sourceLocator', f.source_locator
        ) ORDER BY f.id) FROM ep_public_findings f WHERE f.context_id = c.id${findingWhere}), '[]'::jsonb)
      ) ORDER BY c.id) FROM ep_public_contexts c WHERE c.record_id = r.id${contextWhere}), '[]'::jsonb) AS matches
    FROM page r ORDER BY r.published_on DESC NULLS LAST, r.id DESC`,
    values,
  };
}
