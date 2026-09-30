/** PR1 uses the existing postgres.js client through a small, parameterized boundary. */
export type Parameter = string | number | boolean | null | readonly Parameter[] | { readonly [key: string]: Parameter };
export interface Statement {
  text: string;
  values: Parameter[];
}
export interface Session {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(statement: Statement): Promise<Row[]>;
}
export interface Database extends Session {
  transaction<T>(work: (session: Session) => Promise<T>): Promise<T>;
}
export type JsonObject = { [key: string]: unknown };
export type Imaging = 'ICE' | 'TEE' | 'TTE' | 'OTHER';
export type Population = 'human' | 'animal' | 'bench' | 'simulation' | 'mixed' | 'unknown';
export type StudyDesign =
  | 'randomized' | 'prospective' | 'retrospective' | 'case_report' | 'case_series'
  | 'technical' | 'preclinical' | 'review' | 'unknown';
export type Radiation = 'zero_fluoro' | 'low_fluoro' | 'unspecified';
export type ProductRole = 'evaluated' | 'used_as_tool' | 'incidental_use';
export type Unit = 'patients' | 'animals' | 'lesions' | 'veins' | 'samples' | 'other';
export type TimeUnit = 'day' | 'week' | 'month' | 'year';
export type TimeBasis = 'observed' | 'planned' | 'median' | 'minimum' | 'maximum' | 'unknown';
export type TimeRole = 'follow_up' | 'enrollment_period' | 'procedure' | 'unspecified';
export interface ProductInput {
  id: string;
  name: string;
  kind: 'platform' | 'catheter' | 'generator' | 'mapping_system' | 'imaging' | 'other';
  parentId?: string | null;
}
export interface StudyInput {
  id: string;
  name: string;
  registryId?: string | null;
  reportedCounts?: { value: number; scope: string; sourceRef: string; asOf: string }[];
}
export interface FindingInput {
  key: string;
  endpoint: string;
  label: string;
  numerator?: number | null;
  denominator?: { value: number; unit: Unit; scope: string } | null;
  time?: { role: TimeRole; value: number; unit: TimeUnit; basis: TimeBasis } | null;
  locator: string;
  verified: boolean;
  publicAllowed: boolean;
  evidencePrivate?: JsonObject;
}
export interface ContextInput {
  key: string;
  label: string;
  disease?: string | null;
  imaging: Imaging[];
  imagingPurpose?: string | null;
  radiationStrategy: Radiation;
  products: { productId: string; role: ProductRole; locator: string }[];
  locator: string;
  verified: boolean;
  publicAllowed: boolean;
  evidencePrivate?: JsonObject;
  findings: FindingInput[];
}
export interface ArmInput {
  key: string;
  label: string;
  population: Population;
  reportedSample?: { value: number; unit: Unit; scope: string } | null;
  evidencePrivate?: JsonObject;
  contexts: ContextInput[];
}
export interface RecordInput {
  sourceKey: string;
  doi?: string | null;
  articleId?: string | null;
  title: string;
  sourceUrl: string;
  publishedOn?: string | null;
  studyDesign: StudyDesign;
  materialScope: 'metadata' | 'abstract' | 'partial_fulltext' | 'fulltext';
  sourceVersion: string;
  publication: {
    state: 'draft' | 'published' | 'withdrawn';
    metadataAllowed: boolean;
    basis?: string | null;
    expiresAt?: string | null;
  };
  studyLinks: {
    studyId: string;
    relation: 'primary_report' | 'secondary_report' | 'pooled_analysis' | 'other';
    locator: string;
  }[];
  processingMeta?: JsonObject;
  privateData?: JsonObject;
  arms: ArmInput[];
}
export interface SearchFilter {
  productId?: string;
  disease?: string;
  imaging?: Imaging;
  radiationStrategy?: Radiation;
  population?: Population;
  studyDesign?: StudyDesign;
  endpoint?: string;
  minFollowUp?: { value: number; unit: TimeUnit; basis: TimeBasis };
  limit?: number;
  cursor?: { publishedOn: string | null; id: string };
}
export interface SearchResult extends Record<string, unknown> {
  id: string;
  doi: string | null;
  title: string;
  source_url: string;
  published_on: string | null;
  study_design: StudyDesign;
  material_scope: RecordInput['materialScope'];
  matches: Record<string, unknown>[];
}
export class ResearchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResearchValidationError';
  }
}
export class ResearchImportConflict extends Error {
  readonly recordId: string;
  constructor(recordId: string) {
    super(`Record ${recordId} already exists with different data. PR1 imports are insert-only; review a revision explicitly.`);
    this.name = 'ResearchImportConflict';
    this.recordId = recordId;
  }
}
