import type { ArmInput, ContextInput, FindingInput, RecordInput } from '../../packages/backend/src/research/contracts.ts';

// All fixtures are SYNTHETIC. The numbers exercise contracts; they are not extracted
// from a paper, not licensed article text and must never seed a public content database.
export function finding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    key: 'safety', endpoint: 'safety_events', label: '[SYNTHETIC] short observation',
    numerator: 0, denominator: { value: 121, unit: 'patients', scope: 'observed sample in this fixture' },
    time: { role: 'follow_up', value: 7, unit: 'day', basis: 'observed' },
    locator: 'synthetic-results:p1', verified: true, publicAllowed: true,
    evidencePrivate: { quote: 'PRIVATE_EVIDENCE_NOT_FOR_PUBLIC_OUTPUT' }, ...overrides,
  };
}
export function context(productId: string, overrides: Partial<ContextInput> = {}): ContextInput {
  return {
    key: 'procedure', label: '[SYNTHETIC] procedural context', disease: 'AF',
    imaging: ['TEE'], imagingPurpose: '[SYNTHETIC] transseptal puncture only', radiationStrategy: 'zero_fluoro',
    products: [{ productId, role: 'evaluated', locator: 'synthetic-methods:p1' }],
    locator: 'synthetic-methods:p2', verified: true, publicAllowed: true,
    evidencePrivate: { quote: 'PRIVATE_CONTEXT_QUOTE' }, findings: [finding()], ...overrides,
  };
}
export function arm(productId: string, overrides: Partial<ArmInput> = {}): ArmInput {
  return {
    key: 'a', label: '[SYNTHETIC] arm A', population: 'human',
    reportedSample: { value: 121, unit: 'patients', scope: 'enrolled participants, not an automatic endpoint denominator' },
    evidencePrivate: { quote: 'PRIVATE_ARM_QUOTE' }, contexts: [context(productId)], ...overrides,
  };
}
export function record(sourceKey: string, productId: string, overrides: Partial<RecordInput> = {}): RecordInput {
  return {
    sourceKey, title: `[SYNTHETIC] ${sourceKey}`, sourceUrl: 'https://example.invalid/ep-pr1-fixture',
    publishedOn: '2026-09-01', studyDesign: 'prospective', materialScope: 'abstract', sourceVersion: 'synthetic-v1',
    publication: { state: 'published', metadataAllowed: true, basis: 'Original synthetic fixture; test use only' },
    studyLinks: [], processingMeta: { promptVersion: 'test-only-v1' },
    privateData: { body: 'PRIVATE_RECORD_TEXT', operatorNote: 'PRIVATE_OPERATOR_NOTE' },
    arms: [arm(productId)], ...overrides,
  };
}
