// Every database test file runs on its own copy of the database, so the files run in parallel
// without sharing rows, paid-service budgets or an order (package.json). DATABASE_URL names the
// template, a throwaway database ending in _test or _ci (setup.ts refuses anything else); it is
// created if missing. As the runner's global setup this module brings the template up to date
// (migrations) and removes the copies and scratch folders of the run; as a preload in each
// file's process it copies the template and gives the file its own data and temporary folders.
// *.standalone.test.ts need no database copy; npm run test:standalone runs them without a database.
import "./setup.ts";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";
import postgres from "postgres";

const template = new URL(process.env.DATABASE_URL!);
const name = decodeURIComponent(template.pathname.slice(1));
const suffix = name.slice(name.lastIndexOf("_") + 1);
const copyPattern = `^${name.replace(/\W/g, "\\$&")}_f[0-9]+_${suffix}$`;

function urlOf(database: string) {
  const url = new URL(template);
  url.pathname = `/${database}`;
  return url.toString();
}

async function onServer(fn: (db: postgres.Sql) => Promise<unknown>) {
  const db = postgres(urlOf("postgres"), { max: 1, onnotice: () => {} });
  try {
    await fn(db);
  } finally {
    await db.end();
  }
}

const dropCopies = () =>
  onServer(async (db) => {
    for (const { datname } of await db<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname ~ ${copyPattern}`) {
      await db`DROP DATABASE IF EXISTS ${db(datname)} WITH (FORCE)`;
    }
  });

// Homebrew databases on a Mac only. CI starts its own server on a separate port.
async function openLocalPostgres() {
  if (process.platform !== "darwin" || !["localhost", "127.0.0.1", "[::1]"].includes(template.hostname)
    || (template.port || process.env.PGPORT || "5432") !== "5432"
    || template.searchParams.has("host") || template.searchParams.has("port")) return;
  const prefix = ["/opt/homebrew", "/usr/local"].find((prefix) =>
    existsSync(path.join(prefix, "opt/postgresql@16/bin/pg_ctl"))
    && existsSync(path.join(prefix, "var/postgresql@16/PG_VERSION")));
  if (!prefix) return;
  const helper = spawn("/usr/bin/python3", [
    fileURLToPath(new URL("./local-postgres.py", import.meta.url)),
    path.join(prefix, "opt/postgresql@16/bin"), path.join(prefix, "var/postgresql@16"),
    template.hostname.replace(/^\[|\]$/g, ""),
  ], { detached: true, stdio: ["pipe", "pipe", "inherit"] });
  const closed = once(helper, "close").then(([code]) => {
    if (code !== 0) throw new Error(`Local PostgreSQL helper exited with code ${code}`);
  });
  await Promise.race([
    once(helper.stdout, "data"),
    closed.then(() => { throw new Error("Local PostgreSQL helper exited before the test run started"); }),
  ]);
  return async () => {
    helper.stdin.end();
    await closed;
  };
}

let closeLocalPostgres: (() => Promise<void>) | undefined;

export async function globalSetup() {
  closeLocalPostgres = await openLocalPostgres();
  try {
    await onServer(async (db) => {
      if ((await db`SELECT 1 FROM pg_database WHERE datname = ${name}`).length === 0) await db`CREATE DATABASE ${db(name)}`;
    });
    execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/migrate.ts", import.meta.url))], { stdio: ["ignore", "ignore", "inherit"] });
    await dropCopies(); // left by an interrupted run
  } catch (error) {
    await closeLocalPostgres?.();
    throw error;
  }
}

// Each file's scratch folder is named after the runner, so a run removes only its own leftovers.
const scratchPrefix = (runner: number) => `aihot-test-${runner}-`;

export async function globalTeardown() {
  try {
    await dropCopies();
    for (const entry of readdirSync(tmpdir())) {
      if (entry.startsWith(scratchPrefix(process.pid))) rmSync(path.join(tmpdir(), entry), { recursive: true, force: true }); // a crashed file's
    }
  } finally {
    await closeLocalPostgres?.();
  }
}

// Worker threads a file starts inherit the preload and its copy.
if (process.env.NODE_TEST_CONTEXT && isMainThread) {
  if (process.argv[1]?.endsWith(".standalone.test.ts")) {
    await import("./standalone.ts");
  } else {
    const copy = `${name}_f${process.pid}_${suffix}`;
    await onServer((db) => db`CREATE DATABASE ${db(copy)} TEMPLATE ${db(name)}`);
    process.env.DATABASE_URL = urlOf(copy);
  }
  const scratch = mkdtempSync(path.join(tmpdir(), scratchPrefix(process.ppid)));
  for (const dir of ["data", "tmp"]) mkdirSync(path.join(scratch, dir));
  process.env.AIHOT_DATA_DIR = path.join(scratch, "data");
  process.env.TMPDIR = path.join(scratch, "tmp"); // os.tmpdir(): whatever the file creates goes with it
  process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
}
