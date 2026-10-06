// Architecture boundaries that otherwise hold only by convention, and nothing kept that nothing uses.
// Each rule reads the source and names what breaks it. A rule changes here and in the architecture
// document together.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";

after(closeDb);

const ROOT = path.resolve(import.meta.dirname, "..");
const BACKEND = "packages/backend/src";

/**
 * The source files under a folder, each named by its path from the repository root with "/" between the
 * parts on every system (path.relative gives backslashes on Windows): the rules compare and join these
 * names as POSIX paths.
 */
function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    const full = path.join(entry.parentPath, entry.name);
    const file = path.relative(ROOT, full).split(path.sep).join("/");
    if (/\/(node_modules|build|\.react-router)\//.test(file)) continue;
    out.push({ file, text: readFileSync(full, "utf8") });
  }
  return out;
}

/** Module specifiers a file imports (static, dynamic and type imports). */
const specifiers = (text: string) => [...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);

/** A specifier as a path under packages/backend/src (`events/group.ts`), or null outside the backend. */
function backendPath(file: string, spec: string): string | null {
  if (spec.startsWith("@aihot/backend/")) return `${spec.slice("@aihot/backend/".length)}.ts`;
  if (!spec.startsWith(".")) return null;
  const target = path.posix.relative(BACKEND, path.posix.join(path.posix.dirname(file), spec));
  return target.startsWith("..") ? null : target;
}

function violations(files: Array<{ file: string; text: string }>, broken: (file: string, spec: string) => boolean): string[] {
  return files.flatMap(({ file, text }) => specifiers(text).filter((spec) => broken(file, spec)).map((spec) => `${file} → ${spec}`));
}

test("the web reaches the backend only over HTTP", () => {
  const found = violations([...sources("apps/web"), ...modules().filter(({ file }) => /^modules\/[^/]+\/web(?:\.|\/)/.test(file))], (_file, spec) => spec.startsWith("@aihot/backend") || spec.includes("packages/backend") || spec === "postgres" || spec === "pg-boss");
  assert.deepEqual(found, [], "apps/web imports backend code; read it through /api/site or /api/admin instead");
});

test("packages never import the apps, and nothing below the admin imports it", () => {
  assert.deepEqual(violations(sources("packages"), (_file, spec) => /(^|\/)apps\//.test(spec)), []);
  const found = violations([...sources("packages/backend/src"), ...sources("apps/worker")], (file, spec) =>
    !file.startsWith("packages/backend/src/admin/") && (backendPath(file, spec)?.startsWith("admin/") ?? false));
  assert.deepEqual(found, [], "admin/ is the top layer: move what others need to the folder that owns it");
});

// Public routes read through the public read faces; the rest are the reader's own writes (feedback) and
// the image proxy. Admin and ingest routes may call any backend use case.
const PRIVATE_ROUTES = new Set(["admin.ts", "admin-auth.ts", "ingest.ts"]);
const PUBLIC_READS = [
  /^publication\//, /^site\//, /^lib\//, /^config\.ts$/, /^operations\/feedback\.ts$/, /^media\//, /^jobs\/queue\.ts$/, /^modules\.ts$/,
];

test("public routes read content only through the public read layer", () => {
  const routes = sources("apps/api/src/routes").filter(({ file }) => !PRIVATE_ROUTES.has(path.posix.basename(file)));
  const found = violations(routes, (file, spec) => {
    const target = backendPath(file, spec);
    return target !== null && !PUBLIC_READS.some((allowed) => allowed.test(target));
  });
  assert.deepEqual(found, [], "a public route imports backend internals; add or reuse a function in publication/");
});

// Tables whose rules must not be rewritten elsewhere: the public projection and its sync ledger, paid
// receipts, content pushes, grouping, and the audit trail. Other code reads them freely.
const OWNERS: Record<string, string> = {
  publications: "publication/", selected_ledger: "publication/", selected_state: "publication/", pool_search: "publication/",
  receipts: "providers/receipts.ts", receipt_attempts: "providers/receipts.ts",
  deliveries: "notify/",
  facts: "events/", fact_articles: "events/", stories: "events/", story_signals: "events/", story_aliases: "events/", story_links: "events/",
  story_digests: "events/", grouping_decisions: "events/", grouping_overrides: "events/",
  audit_log: "audit.ts",
};

test("the tables that carry a rule are written only by the code that owns it", () => {
  const found: string[] = [];
  for (const { file, text } of [...sources("packages/backend/src"), ...sources("apps/api/src"), ...sources("apps/worker/src"), ...modules()]) {
    const own = path.posix.relative(BACKEND, file);
    for (const [, table] of text.matchAll(/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+([a-z_]+)\b/gi)) {
      const owner = OWNERS[table!.toLowerCase()];
      if (owner && !own.startsWith(owner)) found.push(`${file} writes ${table} (owner ${owner})`);
    }
  }
  assert.deepEqual(found, []);
});

// The composite rule compares a scope with the 'composite' literal: =, <>, != or IS [NOT] DISTINCT FROM.
test("the public scope and the composite rule are spelled once, in publication/scope.ts", () => {
  const found = [...sources("packages/backend/src"), ...modules()]
    .filter(({ file }) => !file.endsWith("publication/scope.ts"))
    .filter(({ text }) => /(?:=|<>|DISTINCT FROM)\s*'composite'|visible_after <= \$\{/i.test(text))
    .map(({ file }) => file);
  assert.deepEqual(found, [], "use the predicates of publication/scope.ts");
});

// Nothing kept that nothing uses. Stored state and settings outlive the code that used them, and an
// unread field still costs a query; each check names what to delete. They compare names, so a column
// whose name its table's code also uses for something else slips through. Tests, fixtures and local
// tools do not make anything used.
const PRODUCTION = ["packages/backend/src", "packages/contracts/src", "apps/api/src", "apps/worker/src", "apps/web/app"];
/** The site's modules (modules/<name>/), their tests and local tools left out. */
const modules = () => (existsSync(path.join(ROOT, "modules")) ? sources("modules").filter(({ file }) => !/\/(tests|scripts)\//.test(file)) : []);
const production = () => [...PRODUCTION.flatMap((dir) => sources(dir)), { file: "apps/web/server.ts", text: readFileSync(path.join(ROOT, "apps/web/server.ts"), "utf8") }, ...modules()];
const words = (text: string) => new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g));

test("every table and column is used by the code that reads and writes the database", async () => {
  const files = [...["packages/backend/src", "apps/api/src", "apps/worker/src"].flatMap((dir) => sources(dir)), ...modules()].map(({ text }) => words(text));
  const columns = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`;
  const unused = new Set<string>();
  for (const { table_name: table, column_name: column } of columns) {
    const users = files.filter((names) => names.has(table));
    if (users.length === 0) unused.add(`table ${table}`);
    // created_at is the row's own timestamp, kept on every table for operations.
    else if (column !== "created_at" && !users.some((names) => names.has(column))) unused.add(`${table}.${column}`);
  }
  assert.deepEqual([...unused], [], "drop it with a migration in the same change");
});

// import.meta.env.DEV and the like are the web build's own flags, not environment variables.
const ENV_READ = /\b(?:process\.env|(?<!import\.meta\.)env)\.([A-Z][A-Z0-9_]+)|\b(?:process\.env|env)\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]|\b(?:str|int|bool)\(\s*"([A-Z][A-Z0-9_]+)"/g;
const envReads = (files: Array<{ text: string }>) => new Set(files.flatMap(({ text }) => [...text.matchAll(ENV_READ)].map((m) => (m[1] ?? m[2] ?? m[3])!)));
const assigned = (file: string, pattern: RegExp) => [...readFileSync(path.join(ROOT, file), "utf8").matchAll(pattern)].map((m) => m[1]!);

// .env.example is the template. A deployment's own files, where the repository has them, set the rest
// themselves: docker-compose.yml the container settings (database address, data folder, hosts and
// ports), the Caddyfile the HTTPS domain; a server deployment may keep its own templates beside it
// (`<name>.env.example`) and set a few in its systemd units (`Environment=`). Keys and secrets are read by name through credential(group,
// NAME) or a model preset, so a name the code gives whole as a string counts as read, and so does one a
// deployment file substitutes (the database password, the HTTPS domain).
const matches = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((m) => (m[1] ?? m[2])!);
const NAMED = /["']([A-Z][A-Z0-9_]+)["']/g;
const SUBSTITUTED = /\$\{([A-Z][A-Z0-9_]+)|\{\$([A-Z][A-Z0-9_]+)\}/g;
const COMPOSE = "docker-compose.yml";
const DEPLOYMENT = [COMPOSE, "deploy/Caddyfile"].filter((file) => existsSync(path.join(ROOT, file)));
const tracked = (pattern: string) => execFileSync("git", ["ls-files", "--", pattern], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

test("every environment variable the code reads is listed in a template, and every listed one is read", () => {
  const listed = new Set(tracked("*.env.example").flatMap((file) => assigned(file, /^#?\s*([A-Z][A-Z0-9_]+)=/gm)));
  const preset = new Set([
    ...(DEPLOYMENT.includes(COMPOSE) ? assigned(COMPOSE, /^\s+([A-Z][A-Z0-9_]+):\s/gm) : []),
    ...tracked("*.service").flatMap((unit) => assigned(unit, /^Environment="?([A-Z][A-Z0-9_]+)=/gm)),
  ]);
  const read = envReads(production());
  const readAnywhere = new Set([...read, ...envReads(sources("scripts")),
    ...[...production(), ...sources("scripts")].flatMap(({ text }) => matches(text, NAMED)),
    ...DEPLOYMENT.flatMap((file) => matches(readFileSync(path.join(ROOT, file), "utf8"), SUBSTITUTED))]);
  assert.deepEqual([...read].filter((name) => !listed.has(name) && !preset.has(name)), [], "list it in an environment template, or stop reading it");
  assert.deepEqual([...listed].filter((name) => !readAnywhere.has(name)), [], "no code reads it: remove it from the template");
});

// A module can use the engine, but it does not reach into another module; the site composes capabilities.
test("modules do not import other modules", () => {
  const installed = existsSync(path.join(ROOT, "modules")) ? readdirSync(path.join(ROOT, "modules"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  const found = violations(modules(), (file, spec) => {
    const owner = file.split("/")[1];
    if (spec.startsWith(".")) {
      const target = path.posix.join(path.posix.dirname(file), spec).split("/");
      return target[0] === "modules" && target[1] !== owner;
    }
    const target = /^@aihot\/([^/]+)/.exec(spec)?.[1];
    return !!target && installed.includes(target) && target !== owner;
  });
  assert.deepEqual(found, [], "compose modules in site/modules instead of importing their implementation");
});
