// Every editorial prompt lives in the industry pack as a Markdown file (industry/prompts/*.md), so a new
// industry changes its taste by editing text, not code. Two template forms, nothing else:
//   {{name}}     a value the calling step passes (plus siteName, from site/site.ts)
//   {{> file}}   another prompt file, inserted as it is (shared rules)
// A missing value or file is an error, never a silent blank. Versions are content hashes, so a receipt
// and the admin's model page always say which wording produced a result.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SITE } from "@aihot/site";
import { REPO_ROOT } from "../config.ts";

const DIR = path.join(REPO_ROOT, "industry/prompts");
const TOKEN = /\{\{(>\s*)?([A-Za-z][\w.-]*)\s*\}\}/g;

const files = new Map<string, string>();

function raw(name: string): string {
  let text = files.get(name);
  if (text === undefined) {
    text = readFileSync(path.join(DIR, `${name}.md`), "utf8");
    files.set(name, text);
  }
  return text;
}

/** The file with its includes expanded, and the names of every file it read. */
function expand(name: string, seen: string[] = []): { text: string; used: string[] } {
  if (seen.includes(name)) throw new Error(`prompt include cycle: ${[...seen, name].join(" → ")}`);
  const used = [name];
  const text = raw(name).replace(TOKEN, (token, include: string | undefined, key: string) => {
    if (!include) return token;
    const inner = expand(key, [...seen, name]);
    used.push(...inner.used);
    return inner.text;
  });
  return { text, used };
}

/** A prompt with its values filled in. */
export function promptText(name: string, values: Record<string, string> = {}): string {
  const all: Record<string, string> = { siteName: SITE.name, ...values };
  return expand(name).text.replace(TOKEN, (_token, _include, key: string) => {
    const value = all[key];
    if (value === undefined) throw new Error(`prompt ${name}: no value for {{${key}}}`);
    return value;
  });
}

/** `name@hash` over the files a prompt reads, so any edit shows up as a new version. */
export function promptVersion(...names: string[]): string {
  const used = [...new Set(names.flatMap((n) => expand(n).used))].sort();
  const hash = createHash("sha256");
  for (const n of used) hash.update(`${n}\n${raw(n)}\n`);
  return `${names.join("+")}@${hash.digest("hex").slice(0, 10)}`;
}
