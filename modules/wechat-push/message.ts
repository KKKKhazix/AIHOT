// The weekly GitHub rank push's wording, kept out of server.ts so it can be tested without a database
// (modules/*/tests/*.standalone.test.ts). The ranking itself is collected and stored by the
// github-rank module; this only words what that module stored.
import { SITE } from "@aihot/site";

/** One ranked project, as the github-rank module stored it: the article's raw payload and its headline. */
export interface RankedProject {
  rank: number;
  /** "owner/repo"; null when the stored payload carries no repository. */
  repo: string | null;
  /** The stored headline: "GitHub 周飙升榜（2026.10.06–2026.10.11）第 1 名：owner/repo 单周 +29,362★". */
  title: string;
  /** Two sentences about what the project is, written by the model from its own description. */
  description?: string | null;
}

/** The week an edition covers, as github-rank stores it. */
export interface RankEdition {
  from?: string | null;
  to?: string | null;
}

/**
 * The prefix github-rank's projectTitle() puts on every headline. The push names the week once, in its
 * header, so each line drops the prefix; a headline in any other wording is printed whole rather than
 * cut, so a change over there shows up as a longer line instead of a missing project.
 */
const HEADLINE_PREFIX = /^GitHub\s*周飙升榜(（[^）]*）)?第\s*\d+\s*名[：:]\s*/;

/** One project's line, without the address: "1. owner/repo 单周 +29,362★". */
export function projectLine(item: RankedProject): string {
  const title = item.title.trim();
  const stripped = title.replace(HEADLINE_PREFIX, "").trim();
  // The prefix did not match: the headline is in another wording, and printing it whole tells readers
  // more than the bare repository name would.
  if (!stripped) return `${item.rank}. ${item.repo ?? title}`;
  return `${item.rank}. ${stripped === title ? title : stripped}`;
}

/** The repository's address for a stored "owner/repo", or null when it is not one. */
export function projectUrl(repo: string | null): string | null {
  return repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}` : null;
}

/** One description at most: a runaway answer is cut rather than pushed whole. */
const MAX_DESCRIPTION_CHARS = 200;

/**
 * The model's answer to rank-project-description.md, as the prompt asks for it: a `description_zh:`
 * line in a plain-text reply (the same shape as the pack's other writing prompts, hence `json: false`
 * at the call site). A reply in any other shape is still read as the description rather than thrown
 * away, because a longer paragraph beats a missing one in a push.
 *
 * The prompt asks for at most two sentences; the answer is cut to the first two here so a chatty model
 * cannot turn one project into a paragraph. A single sentence is left as it is: upstream's own blurb is
 * often one short line, and the prompt tells the model to write only what it can support rather than
 * pad a second sentence out of the first.
 */
export function parseDescription(text: string | null | undefined): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const labelled = /^description_zh\s*[:：]\s*([\s\S]*)$/m.exec(raw)?.[1];
  const body = (labelled ?? raw).replace(/\s+/g, " ").trim();
  if (!body) return null;
  const sentences = body.match(/[^。！？!?]+[。！？!?]/g);
  const kept = sentences?.length ? sentences.slice(0, 2).join("").trim() : body;
  return kept ? kept.slice(0, MAX_DESCRIPTION_CHARS) : null;
}

/**
 * The whole message: the week once, then one block per project — its line, the two-sentence description
 * and the address. A project the model has not described yet shows its line and address alone rather
 * than a blank paragraph, so a failed or skipped description never holds the push back.
 */
export function composeWeeklyRank(edition: RankEdition | null, items: readonly RankedProject[]): string {
  const week = edition?.from && edition?.to ? `（${edition.from}–${edition.to}）` : "";
  const lines = [`【${SITE.name} GitHub 周飙升榜】${week}`];
  for (const item of items) {
    lines.push("", projectLine(item));
    const description = item.description?.trim();
    if (description) lines.push(description);
    const url = projectUrl(item.repo);
    if (url) lines.push(url);
  }
  return lines.join("\n");
}
