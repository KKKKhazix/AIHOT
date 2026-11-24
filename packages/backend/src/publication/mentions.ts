// The pages names in the site's own text link to (contracts/mentions.ts): the engine's company topics,
// by the topic's name and the company's organisation names, and the installed modules' pages. A page's
// payload carries the ones its texts name; the page links them where a reader meets them first.
import { prepareMentionLookup, withoutSharedNames, type MentionTarget } from "@aihot/contracts/mentions";
import { ENTITIES } from "../editorial/vocabulary.ts";
import { cached, type Cached } from "../lib/cache.ts";
import { serverModules, type ServerModule } from "../modules.ts";
import { TOPICS } from "./topics.ts";

/** A company topic goes by its name, the parts of its name, its aliases and the company's organisation names, not its slug. */
function companyTargets(): MentionTarget[] {
  return TOPICS.filter((t) => t.group === "company").map((t) => ({
    href: `/topics/${t.slug}`,
    names: [...new Set([...t.aliases.filter((a) => a !== t.slug), ...(t.entityId ? ENTITIES[t.entityId]?.orgNames ?? [] : [])])],
  }));
}

// One dictionary per installed set of modules, read again every few minutes so new pages are linked soon.
type Lookup = ReturnType<typeof prepareMentionLookup>;
const dictionaries = new WeakMap<readonly ServerModule[], Cached<Lookup>>();

function dictionary(): Promise<Lookup> {
  const modules = serverModules();
  let d = dictionaries.get(modules);
  if (!d) {
    d = cached(async () => {
      const pages = await Promise.all(modules.map((m) => m.mentions?.() ?? []));
      return prepareMentionLookup(withoutSharedNames([...pages.flat(), ...companyTargets()]));
    }, { freshMs: 5 * 60_000, maxStaleMs: 60 * 60_000 });
    dictionaries.set(modules, d);
  }
  return d.get();
}

/** The pages these texts name, in order of first mention. */
export async function mentionsIn(texts: ReadonlyArray<string | null | undefined>): Promise<MentionTarget[]> {
  const lookup = await dictionary();
  return lookup(texts);
}
