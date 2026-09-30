import type { Session, SearchFilter, SearchResult } from '../research/contracts.ts';
import { publicResearchStatement } from '../research/statements.ts';

// PR1 adds a read function in the existing publication layer, NOT a new HTTP endpoint.
// The injected session executes only parameterized statements against public projections.
export async function listPublicResearch(db: Session, filter: SearchFilter = {}): Promise<SearchResult[]> {
  return db.query<SearchResult>(publicResearchStatement(filter));
}
export async function getPublicResearch(db: Session, recordId: string): Promise<SearchResult | null> {
  const rows = await db.query<SearchResult>(publicResearchStatement({ recordId, limit: 1 }));
  return rows[0] ?? null;
}
