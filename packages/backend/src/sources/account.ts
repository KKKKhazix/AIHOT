// The account an X source reads, and which posts are that account's own.
import { sql } from "../db.ts";
import type { SourceRow } from "./types.ts";

/** The account an X source reads: the first `from:` of its query (names may show it differently, or not at all). */
export const X_HANDLE = /from:([A-Za-z0-9_]{1,15})/i;
export const xHandle = (config: SourceRow["config"]): string | null => X_HANDLE.exec(String(config.query ?? ""))?.[1] ?? null;

/**
 * In SQL: a post is the source's own when both carry the immutable numeric X user id and they match;
 * falls back to case-insensitive handle comparison for sources or historical posts lacking the numeric id.
 */
export function sourceOwnsPost(config: ReturnType<typeof sql>, xPost: ReturnType<typeof sql>) {
  return sql`(
    (${config}->>'xUserId' IS NOT NULL AND ${xPost}->>'authorUserId' IS NOT NULL
      AND ${config}->>'xUserId' = ${xPost}->>'authorUserId')
    OR ((${config}->>'xUserId' IS NULL OR ${xPost}->>'authorUserId' IS NULL)
      AND lower((regexp_match(${config}->>'query', ${X_HANDLE.source}, 'i'))[1]) = lower(nullif(${xPost}->>'handle', '')))
  )`;
}
