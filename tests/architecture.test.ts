// Architecture boundaries (docs/architecture.md) that otherwise hold only by convention. Each rule reads
// the source and names the file that breaks it. A rule changes here and in that document together.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const BACKEND = path.join(ROOT, "packages/backend/src");

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath, entry.name);
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /[/\\](node_modules|build|\.react-router)[/\\]/.test(full)) continue;
    out.push({ file: path.relative(ROOT, full), text: readFileSync(full, "utf8") });
  }
  return out;
}

/** Module specifiers a file imports (static, dynamic and type imports). */
const specifiers = (text: string) => [...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);

/** A specifier as a path under packages/backend/src (`events/group.ts`), or null outside the backend. */
function backendPath(file: string, spec: string): string | null {
  if (spec.startsWith("@aihot/backend/")) return `${spec.slice("@aihot/backend/".length)}.ts`;
  if (!spec.startsWith(".")) return null;
  const target = path.relative(BACKEND, path.resolve(ROOT, path.dirname(file), spec));
  return target.startsWith("..") ? null : target;
}

function violations(files: Array<{ file: string; text: string }>, broken: (file: string, spec: string) => boolean): string[] {
  return files.flatMap(({ file, text }) => specifiers(text).filter((spec) => broken(file, spec)).map((spec) => `${file} → ${spec}`));
}

test("the web reaches the backend only over HTTP", () => {
  const found = violations(sources("apps/web"), (_file, spec) => spec.startsWith("@aihot/backend") || spec.includes("packages/backend") || spec === "postgres" || spec === "pg-boss");
  assert.deepEqual(found, [], "apps/web imports backend code; read it through /api/site or /api/admin instead");
});

test("packages never import the apps, and nothing below the admin imports it", () => {
  assert.deepEqual(violations(sources("packages"), (_file, spec) => /(^|\/)apps\//.test(spec)), []);
  const found = violations([...sources("packages/backend/src"), ...sources("apps/worker")], (file, spec) =>
    !file.startsWith("packages/backend/src/admin/") && (backendPath(file, spec)?.startsWith("admin/") ?? false));
  assert.deepEqual(found, [], "admin/ is the top layer: move what others need to the module that owns it");
});

// Public routes read through the public read faces; the rest are the reader's own writes (feedback,
// analytics) and the image proxy. Admin, intake and ingest routes may call any backend use case.
const PRIVATE_ROUTES = new Set(["admin.ts", "admin-auth.ts", "intake.ts", "ingest.ts"]);
const PUBLIC_READS = [/^publication\//, /^leaderboard\/read\.ts$/, /^monitor\/read\.ts$/, /^site\//, /^analytics\//, /^lib\//, /^config\.ts$/, /^operations\/feedback\.ts$/, /^media\//, /^jobs\/queue\.ts$/];

test("public routes read content only through the public read layer", () => {
  const routes = sources("apps/api/src/routes").filter(({ file }) => !PRIVATE_ROUTES.has(path.basename(file)));
  const found = violations(routes, (file, spec) => {
    const target = backendPath(file, spec);
    return target !== null && !PUBLIC_READS.some((allowed) => allowed.test(target));
  });
  assert.deepEqual(found, [], "a public route imports backend internals; add or reuse a function in publication/");
});

// Tables whose rules must not be rewritten elsewhere: the public projection and its sync ledger, paid
// receipts, content pushes, grouping, and the audit trail. Other modules read them freely.
const OWNERS: Record<string, string> = {
  publications: "publication/", selected_ledger: "publication/", selected_state: "publication/", pool_search: "publication/",
  receipts: "providers/receipts.ts", receipt_attempts: "providers/receipts.ts",
  deliveries: "notify/",
  facts: "events/", fact_articles: "events/", stories: "events/", story_signals: "events/", story_aliases: "events/", story_links: "events/",
  story_digests: "events/", grouping_decisions: "events/", grouping_overrides: "events/", regroup_pending: "events/",
  audit_log: "audit.ts",
};

test("the tables that carry a rule are written only by the module that owns it", () => {
  const found: string[] = [];
  for (const { file, text } of sources("packages/backend/src")) {
    const own = path.relative("packages/backend/src", file);
    for (const [, table] of text.matchAll(/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+([a-z_]+)\b/gi)) {
      const owner = OWNERS[table!.toLowerCase()];
      if (owner && !own.startsWith(owner)) found.push(`${file} writes ${table} (owner ${owner})`);
    }
  }
  assert.deepEqual(found, []);
});

test("the public scope and the composite rule are spelled once, in publication/scope.ts", () => {
  const found = sources("packages/backend/src")
    .filter(({ file }) => !file.endsWith("publication/scope.ts"))
    .filter(({ text }) => /'scope' = 'composite'|visible_after <= \$\{/.test(text))
    .map(({ file }) => file);
  assert.deepEqual(found, [], "use the predicates of publication/scope.ts");
});
