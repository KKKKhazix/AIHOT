// Architecture boundaries and web rules that otherwise hold only by convention, and nothing kept that
// nothing uses. Each rule reads the source and names what breaks it; its message is its documentation.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertNoViolations, sourceFiles, stripComments, topLevelCalls } from "./source-checks.ts";
import { presentationAssertions, rawLoaderPaths } from "./lesson-checks.ts";
import { clockViolationsByFile } from "./test-clock.ts";
import { after, test } from "node:test";
import { importCycles, staticImportGraph, workspaceImportPath } from "./import-graph.ts";
import { fontSizeViolations } from "./font-size.ts";
import { cssMotionTokens, motionViolations } from "./motion.ts";
import { routerLinkViolations, webTextViolations } from "./web-text.ts";
import { ARTICLE_ID_PATTERN } from "@aihot/contracts/taxonomy";
import { SITE } from "@aihot/site";
import { closeDb, sql } from "@aihot/backend/db";

after(closeDb);

test("test fixtures and identities do not depend on the wall clock", () => {
  assertNoViolations(clockViolationsByFile());
});

test("page loaders identify document and data requests by the same pathname", async () => {
  const { pagePathname } = await import("../apps/web/app/lib/api.server.ts");
  for (const [document, data] of [["/", "/_.data"], ["/example", "/example.data"], ["/example/2026-11", "/example/2026-11.data"]]) {
    for (const path of [document, data]) assert.equal(pagePathname(new Request(`https://example.org${path}?page=2`)), document);
  }
  const found = rawLoaderPaths();
  assert.deepEqual(found, [], found.join("\n"));
});

test("browser assertions describe visible behavior", () => {
  assertNoViolations(presentationAssertions());
});

const ROOT = path.resolve(import.meta.dirname, "..");
const BACKEND = "packages/backend/src";

function sources(dir: string, kind = /\.tsx?$/): Array<{ file: string; text: string }> {
  return sourceFiles(dir).filter(file => kind.test(file))
    .map(file => ({ file, text: readFileSync(path.join(ROOT, file), "utf8") }));
}

/** Module specifiers a file imports (static, dynamic and type imports). */
const specifiers = (text: string) => [...text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);

test("browser suites run in the web checks before the parallel backend tests", () => {
  const misplaced = sourceFiles("*.test.ts").filter(file =>
    /^(?:modules\/[^/]+\/)?tests\//.test(file)
    && /\b(?:chromium|firefox|webkit)\.launch\s*\(/.test(readFileSync(path.join(ROOT, file), "utf8")));
  assert.deepEqual(misplaced, [], `请把使用浏览器的测试放进 apps/web/tests 或本模块的 web/tests，随网页测试顺序运行：\n${misplaced.join("\n")}`);
});

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

test("static imports and re-exports do not form initialization cycles", () => {
  const paths = importCycles(staticImportGraph()).map(files => files.join(" → "));
  assert.deepEqual(paths, [], `请把环中共享的规则放回业务所有者，移除反向依赖：\n${paths.join("\n")}`);
});

test("the web reaches the backend only over HTTP", () => {
  const server = /^(?:packages\/backend\/|apps\/(?:api|worker)\/|modules\/[^/]+\/(?:backend\/|api\/|server(?:\.|$))|site\/modules\/server(?:\.|$))/;
  const found = violations([...sources("apps/web"), ...moduleWeb()], (file, spec) =>
    spec === "postgres" || spec === "pg-boss" || server.test(workspaceImportPath(file, spec) ?? ""));
  assert.deepEqual(found, [], "网页通过 HTTP 读取服务端数据；共享的类型和数据定义放在契约中");
});

test("packages never import the apps, contracts stay pure, and nothing below the admin imports it", () => {
  assert.deepEqual(violations(sources("packages"), (file, spec) => workspaceImportPath(file, spec)?.startsWith("apps/") === true),
    [], "共享包依赖应用代码，请将共用定义放回业务包或契约");
  assert.deepEqual(violations(sources("packages/contracts/src"), (file, spec) => {
    const target = workspaceImportPath(file, spec);
    return !!target && !target.startsWith("packages/contracts/") && !target.startsWith("site/") && !target.startsWith("industry/");
  }), [], "contracts 只承载纯数据结构与规则，不得依赖 backend、apps 或 modules");
  const found = violations([...sources("packages/backend/src"), ...sources("apps/worker")], (file, spec) =>
    !file.startsWith("packages/backend/src/admin/") && (backendPath(file, spec)?.startsWith("admin/") ?? false));
  assert.deepEqual(found, [], "admin/ is the top layer: move what others need to the folder that owns it");
});

test("backend directories keep decoupled boundaries and shutdownSignal has one source", () => {
  const editorialAndEvents = violations([...sources(BACKEND + "/editorial"), ...sources(BACKEND + "/events")], (file, spec) => {
    const target = backendPath(file, spec);
    return !!target?.startsWith("jobs/") && target !== "jobs/queue.ts";
  });
  assert.deepEqual(editorialAndEvents, [], "submit work through jobs/queue.ts; worker implementations depend on editorial and events");
  const reportsToJobs = violations(sources(BACKEND + "/reports"), (file, spec) => backendPath(file, spec)?.startsWith("jobs/") ?? false);
  assert.deepEqual(reportsToJobs, [], "reports/ must not import jobs/");
  const mediaOut = violations(sources(BACKEND + "/media"), (file, spec) => {
    const target = backendPath(file, spec);
    return !!target && (target.startsWith("publication/") || target.startsWith("notify/"));
  });
  assert.deepEqual(mediaOut, [], "media/ must not depend on publication/ or notify/");
  const modulesOut = violations(sources(BACKEND).filter(({ file }) => file === `${BACKEND}/modules.ts`), (file, spec) =>
    backendPath(file, spec)?.startsWith("notify/") ?? false);
  assert.deepEqual(modulesOut, [], "modules.ts must not depend on notify/");
  const shutdownImports = [...sources(BACKEND), ...sources("apps"), ...modules()].flatMap(({ file, text }) =>
    [...stripComments(text).matchAll(/\bimport\s+\{[^}]*\bshutdownSignal\b[^}]*\}\s+from\s+["']([^"']+)["']/g)]
      .filter(([, spec]) => backendPath(file, spec!) !== "lib/shutdown.ts")
      .map(([, spec]) => `${file} → ${spec}`));
  assert.deepEqual(shutdownImports, [], "import shutdownSignal only from backend/lib/shutdown.ts");
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

// Engine tables whose rules must not be rewritten elsewhere: the public projection and its sync ledger,
// paid receipts, content pushes, grouping, and the audit trail. Other code reads them freely.
const OWNERS: Record<string, string> = {
  publications: "publication/", selected_ledger: "publication/", selected_state: "publication/", pool_search: "publication/",
  receipts: "providers/receipts.ts", receipt_attempts: "providers/receipts.ts", embeddings: "providers/embeddings.ts",
  deliveries: "notify/",
  facts: "events/", fact_articles: "events/", stories: "events/", story_signals: "events/", story_aliases: "events/", story_links: "events/",
  story_digests: "events/", grouping_decisions: "events/", grouping_overrides: "events/", hot_rankings: "events/hot.ts", story_heat_hourly: "events/hot.ts",
  reports: "reports/", report_revisions: "reports/",
  article_discoveries: "content/materials.ts", article_revisions: "content/materials.ts",
  english_copy: "editorial/english.ts", quote_translations: "editorial/translate.ts", translation_attempts: "editorial/translate.ts",
  admin_sessions: "admin/auth.ts", admin_users: "admin/auth.ts", editorial_overrides: "admin/content.ts",
  selectbench_runs: "admin/selectbench.ts", selectbench_results: "admin/selectbench.ts",
  audit_log: "audit.ts",
  feedback_submission_state: "operations/feedback.ts",
};

// Engine settings keys that belong to one owner; callers read and write them through that owner's functions.
const SETTINGS_OWNERS: ReadonlyArray<{ pattern: RegExp; key: string; owner: string }> = [
  { pattern: /["'`]webhook\.event\./, key: "webhook.event.*", owner: "notify/agent.ts" },
  { pattern: /["'`]models\./, key: "models.*", owner: "editorial/models.ts" },
  { pattern: /["'`]heartbeat\./, key: "heartbeat.*", owner: "operations/heartbeat.ts" },
  { pattern: /["'`]backup\.last["'`]/, key: "backup.last", owner: "operations/backup.ts" },
  { pattern: /["'`]contact_qr["'`]/, key: "contact_qr", owner: "site/contact.ts" },
];

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

test("encapsulated settings keys are queried only by their owners", () => {
  const found: string[] = [];
  for (const { file, text } of [...sources(BACKEND), ...sources("apps/api/src"), ...sources("apps/worker/src"), ...modules()]) {
    const clean = stripComments(text);
    if (!/\b(?:FROM|INTO|UPDATE)\s+settings\b/i.test(clean)) continue;
    const own = path.posix.relative(BACKEND, file);
    for (const rule of SETTINGS_OWNERS) {
      if (rule.pattern.test(clean) && !own.startsWith(rule.owner)) {
        found.push(`${file} queries settings key ${rule.key} directly (owner ${rule.owner})`);
      }
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

test("public article lists share their fields and browse predicate", () => {
  const found: string[] = [];
  for (const { file, text } of [...sources(BACKEND), ...sources("apps/api/src"), ...modules()]) {
    // A SELECT can follow a CTE or contain an optional SQL fragment. Inspect each field list separately.
    for (const match of text.matchAll(/(?:\bSELECT\s+|sql`)([^;`]*?)\bFROM\b|(?:\bSELECT\s+|sql`)([^;`]+?)`/gi)) {
      const projection = match[1] ?? match[2]!;
      if (/\bp\.article_id\s+AS\s+id\b/i.test(projection) && ["p.title", "p.summary", "p.url", "p.category", "p.published_at", "s.name"].every(c => projection.includes(c))
        && !(file === `${BACKEND}/publication/items.ts` && text.slice(0, match.index).endsWith("PUBLIC_ITEM_COLUMNS = "))) {
        found.push(`${file}:${text.slice(0, match.index).split("\n").length} 请引用 publication/items.ts 的 PUBLIC_ITEM_COLUMNS`);
      }
    }
    if (file !== `${BACKEND}/publication/scope.ts` && /\bp\.score\s*(?:>=|>)\s*\$\{SELECTION\.browseFloor\}/.test(text)) {
      found.push(`${file} 请使用 publication/scope.ts 的 browsedCondition`);
    }
  }
  assert.deepEqual(found, [], found.join("\n"));
});

test("WeChat post identity is decoded only by lib/url.ts", () => {
  const duplicates = [...sources(BACKEND), ...modules()].filter(({ file, text }) => file !== `${BACKEND}/lib/url.ts`
    && /(?:searchParams\.(?:get|set)\(\s*["']__biz["']|\[\s*["']__biz["']\s*,\s*["']mid["']\s*,\s*["']idx["'])/.test(text));
  assert.deepEqual(duplicates.map(({ file }) => file), [],
    "使用 wechatPostUrl 读取公众号文章编号，使用 materialIdentityForUrl 查历史签名或短链；采集列表和入库统一用 resolveMaterialIdentity");
});

// Nothing kept that nothing uses. Stored state and settings outlive the code that used them, and an
// unread field still costs a query; each check names what to delete. They compare names, so a column
// whose name its table's code also uses for something else slips through. Tests, fixtures and local
// tools do not make anything used.
const PRODUCTION = ["packages/backend/src", "packages/contracts/src", "apps/api/src", "apps/worker/src", "apps/web/app"];
/** The site's modules (modules/<name>/), their tests and local tools left out. */
const modules = (kind?: RegExp) => (existsSync(path.join(ROOT, "modules")) ? sources("modules", kind).filter(({ file }) => !/\/(tests|scripts)\//.test(file)) : []);
/** The modules' pages: each one's web.tsx and web/ folder. */
const moduleWeb = (kind?: RegExp) => modules(kind).filter(({ file }) => /^modules\/[^/]+\/web(?:\.|\/)/.test(file));
const production = () => [...PRODUCTION.flatMap((dir) => sources(dir)), { file: "apps/web/server.ts", text: readFileSync(path.join(ROOT, "apps/web/server.ts"), "utf8") }, ...modules()];
const words = (text: string) => new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g));

test("article identifiers use the same format at every entry point", () => {
  const copies = production().filter(({ file, text }) =>
    file !== "packages/contracts/src/taxonomy.ts" && text.includes(ARTICLE_ID_PATTERN.toString()));
  assert.deepEqual(copies.map(({ file }) => file), [], "请引用 @aihot/contracts/taxonomy 的 ARTICLE_ID_PATTERN 校验文章编号");
});

test("every table and column is used by the code that reads and writes the database", async () => {
  const files = [...["packages/backend/src", "apps/api/src", "apps/worker/src"].flatMap((dir) => sources(dir)), ...modules()].map(({ text }) => words(text));
  const columns = await sql<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'schema_migrations'`;
  const unused = new Set<string>();
  for (const { table_name: table, column_name: column } of columns) {
    const users = files.filter((names) => names.has(table));
    if (users.length === 0) unused.add(`table ${table}`);
    // created_at is the row's own timestamp, kept on every table for operations (service_prices uses updated_at instead).
    else if (column !== "created_at" && !(table === "service_prices" && column === "updated_at") && !users.some((names) => names.has(column))) unused.add(`${table}.${column}`);
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

test("dynamic feature valves are read only through backend/config.ts, and schedules evaluate collectionEnabled lazily", () => {
  const valves = ["COLLECT_ENABLED", "MODEL_CALLS_ENABLED", "FEISHU_INTERNAL_ENABLED"] as const;
  const copies = production().flatMap(({ file, text }) => {
    if (file === `${BACKEND}/config.ts`) return [];
    const reads = envReads([{ text }]);
    return valves.filter((v) => reads.has(v)).map((v) => `${file} reads ${v}`);
  });
  assert.deepEqual(copies, [], "请使用 backend/config.ts 的 collectionEnabled() / modelCallsEnabled() / feishuInternalEnabled()");
  const schedules = readFileSync(path.join(ROOT, "apps/worker/src/schedules.ts"), "utf8");
  assert.deepEqual(
    topLevelCalls(schedules, "collectionEnabled"),
    [],
    "apps/worker/src/schedules.ts must evaluate collectionEnabled() inside when: callbacks, not at module load",
  );
});

test("single-source server primitives are not duplicated across backend and API", () => {
  const apiFiles = [...sources("apps/api/src"), ...modules().filter(({ file }) => /^modules\/[^/]+\/api\//.test(file))];
  const rawEtag = apiFiles.flatMap(({ file, text }) =>
    stripComments(text).split("\n").flatMap((line, i) =>
      /headers\[\s*["']if-none-match["']\s*\]/i.test(line) && !/\betagMatches\s*\(/.test(line) ? [`${file}:${i + 1}`] : []));
  assert.deepEqual(rawEtag, [], "compare If-None-Match with etagMatches() from apps/api/src/http/respond.ts");

  const rawIp = apiFiles.filter(({ file, text }) =>
    file !== "apps/api/src/http/respond.ts" && /\b(?:req|request)\.ip\b/.test(stripComments(text))).map(({ file }) => file);
  assert.deepEqual(rawIp, [], "read client IP through clientIp() from apps/api/src/http/respond.ts");

  const serverCode = [...sources(BACKEND), ...sources("apps/api/src"), ...sources("apps/worker/src"), ...modules()];
  const quotedSql = serverCode.filter(({ file, text }) =>
    file !== `${BACKEND}/content/posts.ts` && /->'quoted'->>'tweetId'|substring\([^)]*->'quoted'->>'url'/i.test(stripComments(text))).map(({ file }) => file);
  assert.deepEqual(quotedSql, [], "use quotedTweetIdSql() from content/posts.ts");

  const sourceNameRegex = serverCode.filter(({ file, text }) =>
    file !== `${BACKEND}/publication/rules.ts` && /（\[\^（）\]\*）|\^X\[:：\]/.test(stripComments(text))).map(({ file }) => file);
  assert.deepEqual(sourceNameRegex, [], "use publicSourceName / publicSourceNameSql from publication/rules.ts");

  const jinaUrl = serverCode.filter(({ file, text }) =>
    file !== `${BACKEND}/providers/jina.ts` && /r\.jina\.ai/i.test(stripComments(text))).map(({ file }) => file);
  assert.deepEqual(jinaUrl, [], "reference Jina Reader through providers/jina.ts (JINA_PREFIX / fetchViaJina)");

  const screenshotDir = serverCode.filter(({ file, text }) =>
    file !== `${BACKEND}/operations/feedback.ts` && /["'`]feedback-screenshots["'`]/.test(stripComments(text))).map(({ file }) => file);
  assert.deepEqual(screenshotDir, [], "use FEEDBACK_SCREENSHOTS_DIR from operations/feedback.ts");
});

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

// Beijing time is worked out in packages/contracts/src/time.ts. Written out by hand it drifted apart: one
// copy kept milliseconds and one did not, one threw on a 13th month, one formatted through a locale.
// Caught: offset arithmetic, a zone glued onto an interpolated date or time, Intl or SQL given the zone's
// name. A fixed instant written with its zone, or a parser's default zone, converts nothing.
const convertsBeijingTime = (line: string) =>
  /(?<![\d.])8 ?\* ?(?:3_?600|60 ?\* ?60|HOUR\b)|(?<![\d.])28_?800\b/.test(line)
  || (line.includes("+08:00") && line.includes("${"))
  || /(?:timeZone:|tz:|AT TIME ZONE) ?["']Asia\/Shanghai/.test(line);
const CONVERTS_BEIJING_TIME: Record<string, string> = {
  "packages/contracts/src/time.ts": "the conversions themselves",
  "packages/backend/src/editorial/analyze.ts": "the score input keeps the form its prompt was tuned on (whole seconds without .000)",
  "site/changelog/FeatureRelease.tsx": "a changelog entry's Beijing date and time with its zone, to the minute, in dateTime",
  "clients/watchdog/watchdog.mjs": "installed as one file away from the repository, so it cannot import time.ts",
  "clients/mp-watch/articles.ts": "installed away from the repository with only its module's contracts, so it cannot import time.ts",
};

test("Beijing time is converted only in contracts/time.ts", () => {
  const code = ["*.ts", "*.tsx", "*.mjs", "*.js"].flatMap(tracked).filter((file) => !/(^|\/)tests\/|\.test\.ts$|^reference\//.test(file));
  const lines = (file: string) => readFileSync(path.join(ROOT, file), "utf8").split("\n")
    .map((line, i) => ({ at: `${file}:${i + 1}`, line: line.replace(/\s\/\/.*$/, "") }))
    .filter(({ line }) => !/^\s*(\/\/|\/\*|\*)/.test(line));
  const found = code.filter((file) => !(file in CONVERTS_BEIJING_TIME)).flatMap((file) => lines(file).filter(({ line }) => convertsBeijingTime(line)).map(({ at }) => at));
  assert.deepEqual(found, [], "use packages/contracts/src/time.ts, or add the file to CONVERTS_BEIJING_TIME with its reason");
  const stale = Object.keys(CONVERTS_BEIJING_TIME).filter((file) => existsSync(path.join(ROOT, file)) && !lines(file).some(({ line }) => convertsBeijingTime(line)));
  assert.deepEqual(stale, [], "converts nothing any more: take it off CONVERTS_BEIJING_TIME");
});

// A module can use the engine, but it does not reach into another module; the site composes capabilities.
test("modules do not import other modules", () => {
  const installed = existsSync(path.join(ROOT, "modules")) ? readdirSync(path.join(ROOT, "modules"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  const implementations = sources("modules", /\.(?:tsx?|m?js)$/).filter(({ file }) => !/\/tests?\/|\.test\./.test(file));
  const found = violations(implementations, (file, spec) => {
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

// The web's own code: the app, the modules' pages, and the site's pages and drawings, stylesheets included.
// Each line is read without its comments: a word in a comment is neither a class nor a call.
const WEB_CODE = /\.(?:tsx?|css)$/;
const webSources = (kind = WEB_CODE) => [...sources("apps/web/app", kind), ...moduleWeb(kind), ...sources("site", kind)];
const webLines = () => webSources().flatMap(({ file, text }) =>
  text.split("\n")
    .map((line, i) => ({ file, at: `${file}:${i + 1}`, line: line.replace(/\/\*.*?\*\//g, "").replace(/(^|\s)\/\/.*$/, "") }))
    .filter(({ line }) => !/^\s*(\/\/|\/\*|\*)/.test(line)));

test("navigation visibility is defined in shell/nav.ts", () => {
  const outside = webLines().filter(({ file, line }) => file !== "apps/web/app/components/shell/nav.ts"
    && /\b(?:NAV\.hidden|inNav\s*\()/.test(line)).map(({ at }) => at);
  assert.deepEqual(outside, [], "请从 shell/nav.ts 引用导航项的可见状态，需要新的入口时在那里按站点设置定义一次");
});

// Corners come from the radius scale in app.css (mark 5, control 8, tile 10, card 12, panel 14, sheet 16
// pixels) or are pills (full); none takes a corner away. Before the scale, 77 hand-written radii in 12
// sizes from 4 to 20 pixels gave the same kind of box different corners. A radius worked out from a
// drawing's own size (an inline style from a variable) is the drawing's geometry and is not read.
const RADIUS_CLASS = /(?<![\w-])rounded(?:-(?:\[[^\]]*\]|\([^)]*\)|\w+))*/g;
const RADIUS_ON_SCALE = /^rounded(?:-(?:s|e|t|r|b|l|ss|se|es|ee|tl|tr|br|bl))?-(?:mark|control|tile|card|panel|sheet|full|none)$/;
const CSS_RADIUS = /border(?:-[a-z]+)*-radius\s*:\s*([^;}]+)/g;
const CSS_RADIUS_ON_SCALE = /^(?:var\(--radius-(?:mark|control|tile|card|panel|sheet)\)|9999px|0)$/;

test("corners use the radius scale", () => {
  const found = webLines().flatMap(({ at, line }) => [
    ...[...line.matchAll(RADIUS_CLASS)].map(([written]) => written).filter((written) => !RADIUS_ON_SCALE.test(written)),
    ...[...line.matchAll(CSS_RADIUS)].map(([, value]) => value!.trim()).filter((value) => !CSS_RADIUS_ON_SCALE.test(value)),
    ...(/borderRadius\s*:\s*["'`]?\d/.test(line) ? ["borderRadius"] : []),
  ].map((written) => `${at} ${written}`));
  assert.deepEqual(found, [], "use rounded-mark, -control, -tile, -card, -panel, -sheet or -full (var(--radius-…) in CSS); a size the scale lacks is added to the scale in app.css first");
});

// Copying goes through copyText in apps/web/app/lib/clipboard.ts: in-app browsers without the asynchronous
// clipboard fall back to a selection copy, and a copy that fails is reported. Five places wrote to the
// clipboard themselves and skipped the fallback; one of them never copied inside WeChat.
test("the clipboard is written only through lib/clipboard.ts", () => {
  const found = webLines()
    .filter(({ file, line }) => file !== "apps/web/app/lib/clipboard.ts" && /navigator\.clipboard|execCommand\(\s*["']copy/.test(line))
    .map(({ at }) => at);
  assert.deepEqual(found, [], "copy with copyText from lib/clipboard.ts");
});

test("components use React's layout effect directly", () => {
  const environmentChoice = /typeof\s+window\s*[!=]==?\s*["']undefined["']\s*\?\s*(?:(?:[\w.]+|\(\s*\)\s*=>\s*\{\s*\})\s*:\s*)?(?:React\.)?useLayoutEffect\b/;
  const copies = webSources(/\.tsx?$/).filter(({ text }) => environmentChoice.test(text));
  assert.deepEqual(copies.map(({ file }) => file), [], "直接使用 React 的 useLayoutEffect，服务端渲染会跳过它");
});

// Scripts read the reader's reduced-motion preference through apps/web/app/lib/motion.ts (reducedMotion,
// scrollBehavior); stylesheets keep their own media query. Written by hand it was copied into 13 files, some
// guarding against a missing matchMedia and some not, each deciding again how a jump scrolls.
test("scripts read the reduced-motion preference only through lib/motion.ts", () => {
  const found = webLines()
    .filter(({ file, line }) => !file.endsWith(".css") && file !== "apps/web/app/lib/motion.ts" && line.includes("prefers-reduced-motion"))
    .map(({ at }) => at);
  assert.deepEqual(found, [], "use reducedMotion() or scrollBehavior() from lib/motion.ts");
});

test("a gray page is only for previewers: its loader goes through grayGet and answers with GRAY_HEADERS", async () => {
  const { MODULES } = await import("@aihot/site/modules");
  const gray = MODULES.flatMap((m) => (m.pages ?? []).flatMap((p) => ("layout" in p ? p.pages : [p])).filter((p) => p.gray).map((p) => `modules/${m.name}/${p.file}`));
  for (const file of gray) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    assert.ok(/\bgrayGet\b/.test(text) && /\bGRAY_HEADERS\b/.test(text), `${file} is gray: its loader must use grayGet and GRAY_HEADERS`);
  }
});

// Pages are prefetched only when the reader presses a link (IntentLink). React Router's own prefetch runs
// on hover, focus, render or viewport; the phone tab bar kept it after every other link had moved to
// presses, so a narrow desktop window downloaded a tab's page whenever the pointer crossed it.
test("pages are prefetched only through IntentLink", () => {
  const found = webLines()
    .filter(({ file, line }) => file !== "apps/web/app/components/ui/IntentLink.tsx"
      && /\bprefetch\s*=|\bprefetch\s*:\s*["'`]|PrefetchPageLinks|rel=["']prefetch/.test(line))
    .map(({ at }) => at);
  assert.deepEqual(found, [], "link with IntentLink (in PillTabs, prefetchOnPress), which prefetches when the reader presses");
});

test("admin page loaders use adminPageGet and GRAY_HEADERS", async () => {
  const { MODULES } = await import("@aihot/site/modules");
  const pages = MODULES.flatMap((m) => (m.pages ?? []).flatMap((p) => ("layout" in p ? p.pages : [p])).filter((p) => p.admin).map((p) => `modules/${m.name}/${p.file}`));
  for (const file of pages) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    assert.ok(/\badminPageGet\b/.test(text) && /\bGRAY_HEADERS\b/.test(text), `${file} must use adminPageGet and GRAY_HEADERS`);
  }
});

// Animations use Presence.tsx (CSS transitions), CSS keyframes or the Web Animations API, not a runtime animation library.
test("web code does not import motion or framer-motion", () => {
  const found = violations([...sources("apps/web"), ...moduleWeb(), ...sources("site")], (_file, spec) => /^(?:motion|framer-motion)(?:$|\/)/.test(spec));
  assert.deepEqual(found, [], "animate with Presence.tsx, CSS keyframes or the Web Animations API instead of motion");
});

test("web font sizes use the design scale", () => {
  assertNoViolations(fontSizeViolations());
});

// One motion language (app.css, "Motion"): curves and lengths come from its tokens, animation classes exist,
// smooth scrolling respects reduced motion. Written by hand it had drifted into a dozen curves and timings.
test("web motion uses the site's curves and lengths", () => {
  assertNoViolations(motionViolations());
});

test("lib/motion.ts repeats app.css's motion tokens for scripts", async () => {
  const { MOTION } = await import("../apps/web/app/lib/motion.ts");
  assert.deepEqual({ ...MOTION }, cssMotionTokens(), "change the length or curve in app.css and lib/motion.ts together");
});

// The English edition (/en/…): reader-facing text is written in both languages where it is used, so a page
// never shows Chinese to an English reader or loses its English when the Chinese is edited (lib/i18n.ts).
// Pages without an English edition are listed in web-text.ts CHINESE_ONLY with the reason.
test("reader-facing web text has its English beside it", () => {
  assertNoViolations(webTextViolations());
});

test("site links keep the page's language", () => {
  assertNoViolations(routerLinkViolations());
});

test("web browser storage goes through lib/browser-storage.ts and filters cross-tab storage events", () => {
  const directStorageAllowed = new Set([
    "apps/web/app/lib/browser-storage.ts",
    "apps/web/app/lib/local-state.ts", // inline APPEARANCE_BOOT_SCRIPT executed before module boot
    "apps/web/app/lib/render-recovery.ts", // early crash-recovery boot path
  ]);
  const direct = webSources(/\.tsx?$/)
    .filter(({ file, text }) => !directStorageAllowed.has(file) && /\b(?:localStorage|sessionStorage)\b/.test(stripComments(text)))
    .map(({ file }) => file);
  assert.deepEqual(direct, [], "read and write browser storage through apps/web/app/lib/browser-storage.ts");

  const unfiltered = webSources(/\.tsx?$/)
    .filter(({ text }) => {
      const clean = stripComments(text);
      return /addEventListener\(\s*["']storage["']/.test(clean) && !/\bisLocalStorageEvent\b/.test(clean);
    })
    .map(({ file }) => file);
  assert.deepEqual(unfiltered, [], "guard window storage listeners with isLocalStorageEvent() from lib/browser-storage.ts");
});

test("public web loaders use loadOr404, meta titles use titled/pageMeta, and touch targets keep 44px on coarse pointers", () => {
  const apiGetAllowed = new Set([
    "apps/web/app/entry.server.tsx", // fire-and-forget SSR status report
    "apps/web/app/lib/api.server.ts", // definition itself
    "apps/web/app/features/item/page.server.ts", // optional followups probe (.catch(() => null))
    "apps/web/app/routes/about.tsx", // optional contact/stats probes
    "apps/web/app/routes/admin-login.tsx", // login options probe
    "apps/web/app/routes/agent.tsx", // optional health badge probe
  ]);
  const bareApiGet = [...sources("apps/web/app", /\.tsx?$/), ...moduleWeb(/\.tsx?$/)]
    .filter(({ file, text }) => !apiGetAllowed.has(file) && /\bapiGet\s*(?:<[^>]+>)?\s*\(/.test(stripComments(text)))
    .map(({ file }) => file);
  assert.deepEqual(bareApiGet, [], "use loadOr404 / grayGet / adminPageGet in page loaders so 404/503 responses keep proper status");

  const siteSuffix = new RegExp(`·\\s*${SITE.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const hardcodedTitle = [...sources("apps/web/app", /\.tsx?$/), ...moduleWeb(/\.tsx?$/)]
    .filter(({ text }) => siteSuffix.test(stripComments(text)))
    .map(({ file }) => file);
  assert.deepEqual(hardcodedTitle, [], "use pageMeta() or titled() from lib/seo.ts instead of hardcoding the site title suffix");

  const controls = readFileSync(path.join(ROOT, "apps/web/app/components/ui/Controls.tsx"), "utf8");
  const filterSearch = readFileSync(path.join(ROOT, "apps/web/app/components/ui/FilterSearch.tsx"), "utf8");
  assert.ok(controls.includes("touch:h-11"), "Controls.tsx must keep 44px touch targets on coarse pointers");
  assert.ok(filterSearch.includes("touch:h-11"), "FilterSearch.tsx must keep 44px touch targets on coarse pointers");
});
