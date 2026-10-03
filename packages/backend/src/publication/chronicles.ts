// A company's chronicle band: its curated history in industry/chronicles/{slug}.json up to the month the
// file is curated through, then the milestones the site picked up itself after it; without a file, those
// alone. The files ship with the site; one that does not follow the format fails the read.
import type { TopicMilestone, TopicMonth } from "@aihot/contracts/site";
import { beijingDate } from "@aihot/contracts/time";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../config.ts";
import { CHRONICLE_KINDS } from "./topic-chronicle.ts";
import { findTopic } from "./topics.ts";

export const CHRONICLES_DIR = path.join(REPO_ROOT, "industry/chronicles");

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

const Entry = z
  .strictObject({
    date: z.string().regex(DATE, "date is YYYY, YYYY-MM or YYYY-MM-DD"),
    kind: z.enum(Object.keys(CHRONICLE_KINDS) as [string, ...string[]]),
    title: z.string().trim().min(1).max(60),
    summary: z.string().trim().min(1).max(80).optional(),
    major: z.boolean().optional(),
    story: z.uuid().optional(),
    item: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
    url: z.url({ protocol: /^https$/ }).optional(),
  })
  .refine((e) => [e.story, e.item, e.url].filter(Boolean).length <= 1, "at most one of story, item, url");

const File = z
  .strictObject({ topic: z.string(), through: z.string().regex(MONTH, "through is YYYY-MM"), events: z.array(Entry).min(1) })
  .refine((f) => f.events.every((e) => e.date.slice(0, 7) <= f.through), "an event is after the month the file is curated through");

export type CuratedChronicle = z.infer<typeof File>;

/** One curated file, checked: throws the reason when it does not follow the format. */
export function parseChronicle(json: unknown, slug: string): CuratedChronicle {
  const parsed = File.safeParse(json);
  if (!parsed.success) throw new Error(`${slug}.json: ${parsed.error.issues.map((i) => `${i.path.join(".") || "file"}: ${i.message}`).join("; ")}`);
  if (parsed.data.topic !== slug) throw new Error(`topic "${parsed.data.topic}" in a file named ${slug}.json`);
  if (findTopic(slug)?.group !== "company") throw new Error(`${slug} is not a company topic`);
  return parsed.data;
}

let curated: Map<string, CuratedChronicle> | null = null;

/** A company's curated history, read on first use (topics.ts and this module import each other). */
export function curatedChronicle(slug: string): CuratedChronicle | undefined {
  curated ??= new Map((existsSync(CHRONICLES_DIR) ? readdirSync(CHRONICLES_DIR) : []).filter((f) => f.endsWith(".json")).map((f) => {
    const name = f.slice(0, -".json".length);
    return [name, parseChronicle(JSON.parse(readFileSync(path.join(CHRONICLES_DIR, f), "utf8")), name)];
  }));
  return curated.get(slug);
}

const linkOf = (e: CuratedChronicle["events"][number]) =>
  e.story ? `/story/${e.story}` : e.item ? `/items/${e.item}` : (e.url ?? null);

/** Automatic candidates start after the curated months, before selection or event deduplication. */
export const afterCuratedHistory = (curated: CuratedChronicle | undefined, month: string): boolean => !curated || month > curated.through;

/**
 * The band, oldest first: the curated history, then the months after it that the site picked up, never
 * marked as defining events. A year-only date sorts before that year's months.
 */
export function companyMilestones(curated: CuratedChronicle | undefined, picked: TopicMonth[]): TopicMilestone[] {
  const history: TopicMilestone[] = (curated?.events ?? []).map((e) => ({
    date: e.date,
    kind: e.kind,
    title: e.title,
    headline: null,
    summary: e.summary ?? null,
    href: linkOf(e),
    external: !!e.url,
    major: e.major ?? false,
  }));
  const since: TopicMilestone[] = picked
    .filter((m) => afterCuratedHistory(curated, m.month))
    .flatMap((m) => m.events)
    .map((e) => ({
      date: beijingDate(e.at),
      kind: e.kind,
      title: e.label,
      headline: e.title,
      summary: null,
      href: e.href,
      external: false,
      major: false,
    }));
  const byDate = (a: TopicMilestone, b: TopicMilestone) => a.date.localeCompare(b.date);
  return [...history.sort(byDate), ...since.sort(byDate)];
}
