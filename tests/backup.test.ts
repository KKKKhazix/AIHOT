// Backups restore: a real database dump and file archive (uploads and feedback screenshots) are
// unpacked and read back; the object store is a stand-in inside this process. A missing uploads directory
// needs no file archive, an unreadable one is not; a file archive that fails still ships the database and
// reports tar's own words, not the command line in front of them.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { runBackup } from "@aihot/backend/operations/backup";
import { submitFeedback } from "@aihot/backend/operations/feedback";

const run = promisify(execFile);
const T = tag();
const originalDataDir = config.dataDir;
const originalFetch = globalThis.fetch;
const env = {
  DB_BACKUP_STORE_SECRET_ID: "test-backup-id", DB_BACKUP_STORE_SECRET_KEY: "test-backup-key",
  DB_BACKUP_STORE_BUCKET: "test-bucket", DB_BACKUP_STORE_REGION: "test-region", DB_BACKUP_STORE_DOMAIN: "backup.invalid",
  FEISHU_INTERNAL_ENABLED: "false",
};
const originalEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
const roots: string[] = [];
const databases = new Set<string>();
const objects = new Map<string, Buffer>();
const PNG = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#808080" } }).png().toBuffer();
const NOW = new Date("2026-11-01T04:00:00Z");
// Backups are named after the database ("news_db" → news-db-…).
const stem = sql.options.database.toLowerCase().replace(/[^a-z0-9]+/g, "-");

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, "https://backup.invalid", "the backup fixture must not contact any real service");
  const chunks: Buffer[] = [];
  for await (const chunk of init!.body as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  objects.set(url.pathname.slice(1), Buffer.concat(chunks));
  return new Response(null, { status: 200 });
}) as typeof fetch;

beforeEach(async () => {
  config.dataDir = await mkdtemp(path.join(tmpdir(), "aihot-backup-files-"));
  roots.push(config.dataDir);
  objects.clear();
});
after(async () => {
  globalThis.fetch = originalFetch;
  config.dataDir = originalDataDir;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const name of databases) await sql.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
  await closeDb();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function extractSavedFiles() {
  const destination = await mkdtemp(path.join(tmpdir(), "aihot-backup-restored-"));
  roots.push(destination);
  const archive = objects.get(`monthly/${stem}-files-202611010400.tar.gz`);
  assert.ok(archive, "backup must supply the real file archive");
  const archivePath = path.join(destination, "files.tar.gz");
  await writeFile(archivePath, archive);
  const data = path.join(destination, "data");
  await mkdir(data);
  await run("tar", ["-xzf", archivePath, "-C", data]);
  return { destination, data };
}

test("a real paired restore opens a feedback screenshot when forwarding is disabled and uploads are absent", async () => {
  const content = `Fictional backup feedback ${T}`;
  const { id } = await submitFeedback({ content, screenshot: { mime: "image/png", data: PNG }, ip: "203.0.113.220", userAgent: `test-${T}` });
  const [before] = await sql`SELECT screenshot_key, forward_error FROM feedback WHERE id = ${id}`;
  assert.match(before!.screenshot_key, /^local:/);
  assert.equal(before!.forward_error, "pending");
  const externalKey = `feishu:synthetic-${T}`;
  const [external] = await sql<{ id: number }[]>`INSERT INTO feedback (content, source_hash, screenshot_key) VALUES ('Fictional external reference', ${`external:${T}`}, ${externalKey}) RETURNING id`;
  const summary = await runBackup(NOW);
  assert.equal(summary.uploaded, true);
  const { destination, data } = await extractSavedFiles();
  const dump = objects.get(`monthly/${stem}-202611010400.dump`);
  assert.ok(dump, "backup must supply the real database dump");
  const dumpPath = path.join(destination, "database.dump");
  await writeFile(dumpPath, dump);
  // Next to this file's own database, and dropped with it.
  const name = `${new URL(config.databaseUrl).pathname.slice(1)}_restore_test`;
  assert.match(name, /^[a-z0-9_]+_test$/);
  await sql.unsafe(`CREATE DATABASE "${name}"`);
  databases.add(name);
  const restoredUrl = new URL(config.databaseUrl);
  restoredUrl.pathname = `/${name}`;
  await run("pg_restore", ["--exit-on-error", "--no-owner", "--dbname", restoredUrl.href, dumpPath], { maxBuffer: 16 * 1024 * 1024 });
  // A new process sees only the restored database and folder, never the original screenshot.
  await run(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { existsSync } from "node:fs";
    import { readFile } from "node:fs/promises";
    import { feedbackScreenshot } from "@aihot/backend/admin/feedback";
    import { closeDb, sql } from "@aihot/backend/db";
    try {
      const [row] = await sql\`SELECT content, screenshot_key FROM feedback WHERE id = \${Number(process.env.RESTORED_ID)}\`;
      assert.equal(row.content, process.env.RESTORED_CONTENT);
      assert.equal(row.screenshot_key, process.env.RESTORED_KEY);
      const [external] = await sql\`SELECT screenshot_key FROM feedback WHERE id = \${Number(process.env.RESTORED_EXTERNAL_ID)}\`;
      assert.equal(external.screenshot_key, process.env.RESTORED_EXTERNAL_KEY);
      assert.equal(await feedbackScreenshot(Number(process.env.RESTORED_EXTERNAL_ID)), null);
      const file = await feedbackScreenshot(Number(process.env.RESTORED_ID));
      assert.ok(file && existsSync(file), "restored local feedback screenshot must exist");
      assert.deepEqual(await readFile(file), Buffer.from(process.env.RESTORED_BYTES, "base64"));
    } finally { await closeDb(); }
  `], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, DATABASE_URL: restoredUrl.href, AIHOT_DATA_DIR: data, RESTORED_ID: String(id), RESTORED_CONTENT: content, RESTORED_KEY: before!.screenshot_key, RESTORED_BYTES: PNG.toString("base64"), RESTORED_EXTERNAL_ID: String(external!.id), RESTORED_EXTERNAL_KEY: externalKey } });
});


async function save(relative: string, data = PNG) {
  const file = path.join(config.dataDir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

test("both attachment roots restore nested paths and bytes, without caches or previous backups", async () => {
  const upload = Buffer.from("fictional uploaded file");
  await save("uploads/nested/user-file.bin", upload);
  await save("feedback-screenshots/local.png");
  for (const dir of ["imgcache", "ogcache", "backups"]) await save(`${dir}/excluded.bin`, Buffer.from("not an attachment"));
  const summary = await runBackup(NOW);
  assert.equal(summary.uploaded, true);
  const { data } = await extractSavedFiles();
  assert.deepEqual((await readdir(data)).sort(), ["feedback-screenshots", "uploads"]);
  assert.deepEqual(await readFile(path.join(data, "uploads/nested/user-file.bin")), upload);
  assert.deepEqual(await readFile(path.join(data, "feedback-screenshots/local.png")), PNG);
  assert.deepEqual([...objects.keys()].sort(), ["monthly"].flatMap(prefix => [`${prefix}/${stem}-202611010400.dump`, `${prefix}/${stem}-files-202611010400.tar.gz`]).sort());
  for (const object of summary.objects) assert.equal(object.sha256, createHash("sha256").update(objects.get(object.key)!).digest("hex"));
});


// One root present and the other absent is the first test (screenshots kept, uploads absent).
for (const dirs of [[], ["uploads", "feedback-screenshots"], ["uploads/empty/nested"]]) {
  test(`missing/empty roots produce only the database backup: ${dirs.join("+") || "neither"}`, async () => {
    for (const dir of dirs) await mkdir(path.join(config.dataDir, dir), { recursive: true });
    const summary = await runBackup(NOW);
    assert.equal(summary.uploaded, true);
    assert.equal(summary.objects.length, 1);
    assert.ok(summary.objects[0]!.key.endsWith(".dump"));
    assert.equal((await readdir(path.join(config.dataDir, "backups"))).length, 1);
  });
}

test("an unreadable upload directory cannot become a successful empty backup", async () => {
  assert.equal((await runBackup(NOW)).uploaded, true);
  const shipped = objects.size;
  await symlink("uploads", path.join(config.dataDir, "uploads")); // ELOOP, without depending on root/permission behavior
  await assert.rejects(runBackup(new Date("2026-11-01T04:01:00Z")), /ELOOP/);
  assert.equal(objects.size, shipped + 1, "ship the new database without an empty replacement for unreadable files");
  const [after] = await sql`SELECT value FROM settings WHERE key = 'backup.last'`;
  assert.equal(after!.value.uploaded, false, "unreadable attachments cannot count as a successful backup");
  assert.match(after!.value.filesError, /ELOOP/);
});

test("unreadable nested directories still ship the database and fail the attachment backup", { skip: process.getuid?.() === 0 }, async () => {
  await save("uploads/restricted/file.txt", Buffer.from("fixture"));
  const directory = path.join(config.dataDir, "uploads/restricted");
  await chmod(directory, 0);
  try {
    await assert.rejects(runBackup(NOW), /database backed up, but the file archive failed:.*EACCES/);
    assert.equal(objects.size, 1);
    assert.ok([...objects.keys()][0]!.endsWith(".dump"));
    const [row] = await sql`SELECT value FROM settings WHERE key = 'backup.last'`;
    assert.equal(row!.value.uploaded, false);
    assert.match(row!.value.filesError, /EACCES/);
  } finally { await chmod(directory, 0o700); }
});

async function withPackingFailures(failures: number, action: (count: () => Promise<number>) => Promise<void>) {
  const bin = path.join(config.dataDir, "test-bin");
  await mkdir(bin);
  const countFile = path.join(bin, "count");
  const realTar = (await run("sh", ["-c", "command -v tar"])).stdout.trim();
  assert.ok(path.isAbsolute(realTar));
  // Only this process's command lookup changes: restoring and the successful attempts run the real tar.
  await writeFile(path.join(bin, "tar"), `#!/bin/sh
n=0
if [ -f "$BACKUP_TEST_COUNT" ]; then n=$(cat "$BACKUP_TEST_COUNT"); fi
n=$((n+1))
printf '%s' "$n" > "$BACKUP_TEST_COUNT"
if [ "$n" -le "$BACKUP_TEST_FAILURES" ]; then echo 'fictional packing failure' >&2; exit 2; fi
exec "$BACKUP_TEST_TAR" "$@"
`, { mode: 0o755 });
  const replacement = { PATH: `${bin}:${process.env.PATH}`, BACKUP_TEST_COUNT: countFile, BACKUP_TEST_FAILURES: String(failures), BACKUP_TEST_TAR: realTar };
  const previous = Object.fromEntries(Object.keys(replacement).map(key => [key, process.env[key]]));
  Object.assign(process.env, replacement);
  try { await action(async () => Number(await readFile(countFile, "utf8"))); }
  finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test("packing retries once and a successful retry preserves the screenshot", async () => {
  await save("feedback-screenshots/retry.png");
  await withPackingFailures(1, async count => {
    assert.equal((await runBackup(NOW)).uploaded, true);
    assert.equal(await count(), 2);
  });
  const { data } = await extractSavedFiles();
  assert.deepEqual(await readFile(path.join(data, "feedback-screenshots/retry.png")), PNG);
});

test("persistent packing failure still sends the database and reports incomplete backup", async () => {
  await save("feedback-screenshots/failure.png");
  await withPackingFailures(2, async count => {
    await assert.rejects(runBackup(NOW), /database backed up, but the file archive failed: fictional packing failure/);
    assert.equal(await count(), 2);
  });
  assert.equal(objects.size, 1);
  assert.ok([...objects.keys()].every(key => key.endsWith(".dump")));
  const [row] = await sql`SELECT value FROM settings WHERE key = 'backup.last'`;
  assert.equal(row!.value.uploaded, false);
  assert.match(row!.value.filesError, /^fictional packing failure/);
  assert.doesNotMatch(row!.value.filesError, /Command failed|-czf/, "the command line would crowd out the reason");
  assert.equal(row!.value.objects.length, 1);
  assert.deepEqual(await readFile(path.join(config.dataDir, "feedback-screenshots/failure.png")), PNG);
});

test("local retention keeps three dump/archive pairs without deleting source attachments", async () => {
  await save("feedback-screenshots/retained.png");
  for (const day of [1, 2, 3, 4]) await runBackup(new Date(`2026-11-0${day}T04:00:00Z`));
  assert.deepEqual((await readdir(path.join(config.dataDir, "backups"))).sort(), [2, 3, 4].flatMap(day => [`${stem}-2026110${day}0400.dump`, `${stem}-files-2026110${day}0400.tar.gz`]).sort());
  assert.deepEqual(await readFile(path.join(config.dataDir, "feedback-screenshots/retained.png")), PNG);
});

test("a failed database dump keeps connection credentials out of argv and the reported error", async () => {
  const bin = path.join(config.dataDir, "dump-bin");
  await mkdir(bin);
  const captured = path.join(bin, "invocation.json");
  await writeFile(path.join(bin, "pg_dump"), `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ args: process.argv.slice(2), user: process.env.PGUSER, password: process.env.PGPASSWORD }));
console.error("fictional dump refusal");
process.exit(2);
`, { mode: 0o755 });
  const originalUrl = config.databaseUrl;
  const originalPath = process.env.PATH;
  const connection = new URL(originalUrl);
  connection.username = "fictional-backup-user";
  connection.password = "fictional-p@ss:word";
  config.databaseUrl = connection.href;
  process.env.PATH = `${bin}:${originalPath}`;
  try {
    for (const queryCredentials of [false, true]) {
      if (queryCredentials) {
        connection.username = connection.password = "";
        connection.searchParams.set("user", "fictional-backup-user");
        connection.searchParams.set("password", "fictional-p@ss:word");
        config.databaseUrl = connection.href;
      }
      await assert.rejects(runBackup(NOW), (error: Error) => {
        assert.match(error.message, /fictional dump refusal/);
        assert.doesNotMatch(error.message, /fictional-backup-user|fictional-p|p%40ss|word@/);
        return true;
      });
      const invocation = JSON.parse(await readFile(captured, "utf8"));
      assert.doesNotMatch(JSON.stringify(invocation.args), /fictional-backup-user|fictional-p|p%40ss|word@/);
      assert.equal(invocation.user, "fictional-backup-user");
      assert.equal(invocation.password, "fictional-p@ss:word");
    }
    assert.equal(objects.size, 0);
  } finally {
    config.databaseUrl = originalUrl;
    process.env.PATH = originalPath;
  }
});


// A release must let the real dump/archive finish and record its uploaded pair before the worker exits.
// Killing every process with SIGTERM used to interrupt pg_dump (and make tar need a second attempt).
for (const phase of ["pg_dump", "tar"] as const) {
  test(`worker stop drains a real ${phase} without terminating or restarting it`, { timeout: 30_000 }, async () => {
    const locked = await sql.reserve();
    await sql`CREATE TABLE IF NOT EXISTS backup_shutdown_probe (id integer)`;
    await locked`BEGIN`;
    if (phase === "pg_dump") await locked`LOCK TABLE backup_shutdown_probe IN ACCESS EXCLUSIVE MODE`;
    if (phase === "tar") await save("uploads/synthetic.bin", randomBytes(16 * 1024 * 1024));
    const messages: Array<{ cmd?: string; pid?: number; completed?: boolean; error?: string }> = [];
    const child = spawn(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import cp from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      const exec = cp.execFile;
      cp.execFile = (...args) => {
        const child = exec(...args);
        process.send({ cmd: args[0], pid: child.pid });
        return child;
      };
      syncBuiltinESMExports();
      const { runBackup } = await import("@aihot/backend/operations/backup");
      const { getBoss, stopBoss } = await import("@aihot/backend/jobs/queue");
      const { closeDb } = await import("@aihot/backend/db");
      globalThis.fetch = async (input, init) => {
        assert.equal(new URL(input).origin, "https://backup.invalid");
        for await (const chunk of init.body) {} // consume the real dump/archive, never send it outside
        return new Response(null, { status: 200 });
      };
      const boss = await getBoss();
      const name = "test.backup.shutdown";
      await boss.createQueue(name, { retryLimit: 0 });
      await boss.work(name, { pollingIntervalSeconds: 0.5 }, async () => {
        try { await runBackup(); process.send({ completed: true }); }
        catch (error) { process.send({ error: error.message }); throw error; }
      });
      process.once("SIGTERM", async () => { await stopBoss(); await closeDb(); process.exit(0); });
      await boss.send(name, {});
    `], { cwd: path.resolve(import.meta.dirname, ".."), env: { ...process.env, AIHOT_DATA_DIR: config.dataDir }, detached: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    child.on("message", message => messages.push(message as typeof messages[number]));
    const exited = once(child, "exit");
    const wait = async (condition: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 15_000;
      while (!await condition()) {
        assert.ok(child.exitCode === null && child.signalCode === null && Date.now() < deadline, `backup phase not reached: ${stderr} ${JSON.stringify(messages)}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    let held: number | undefined;
    try {
      await wait(() => messages.some(message => message.cmd === phase));
      if (phase === "pg_dump") {
        await wait(async () => (await sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'pg_dump' AND wait_event_type = 'Lock'`).length > 0);
      } else {
        held = messages.find(message => message.cmd === phase)!.pid!;
        process.kill(held, "SIGSTOP");
      }
      // The supervisor sends the graceful signal to the worker, which owns its child lifetimes.
      process.kill(child.pid!, "SIGTERM");
      await locked`ROLLBACK`;
      if (held) { process.kill(held, "SIGCONT"); held = undefined; }
      const [code, signal] = await exited;
      assert.equal(signal, null, stderr);
      assert.equal(code, 0, stderr);
      assert.ok(messages.some(message => message.completed), JSON.stringify(messages));
      assert.equal(messages.filter(message => message.cmd === phase).length, 1, "shutdown must not restart a killed backup subprocess");
    } finally {
      await locked`ROLLBACK`;
      locked.release();
      if (held) process.kill(held, "SIGCONT");
      if (child.exitCode === null && child.signalCode === null) { process.kill(-child.pid!, "SIGKILL"); await exited; }
    }
  });
}

test("a real dump preserves libpq query parameter escaping", async () => {
  const originalUrl = config.databaseUrl;
  config.databaseUrl = `${originalUrl}${originalUrl.includes("?") ? "&" : "?"}options=-c%20statement_timeout%3D0&application_name=fictional%2Bbackup`;
  try { assert.equal((await runBackup(NOW)).uploaded, true); }
  finally { config.databaseUrl = originalUrl; }
});
