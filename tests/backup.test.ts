// A missing uploads directory is a valid empty backup; an unreadable directory is not. Failure to
// inspect it must never upload an empty file archive and record a successful backup. A file archive
// that fails reports tar's own words, not the command line in front of them.
import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { runBackup } from "@aihot/backend/operations/backup";

// The upload transport is stubbed; pg_dump and pg_restore run against this file's isolated DB.
const keys: string[] = [];
const server = http.createServer((req, res) => {
  keys.push(req.url!);
  req.resume();
  req.on("end", () => res.end());
});
const realFetch = globalThis.fetch;
const uploads = path.join(config.dataDir, "uploads");
// Backups are named after the database ("news_db" → news-db-…).
const stem = sql.options.database.toLowerCase().replace(/[^a-z0-9]+/g, "-");

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    url.protocol = "http:";
    return realFetch(url, init);
  };
  const port = (server.address() as { port: number }).port;
  Object.assign(process.env, {
    DB_BACKUP_STORE_SECRET_ID: "test-backup-key", DB_BACKUP_STORE_SECRET_KEY: "test-backup-secret",
    DB_BACKUP_STORE_BUCKET: "test-bucket", DB_BACKUP_STORE_REGION: "test-region", DB_BACKUP_STORE_DOMAIN: `127.0.0.1:${port}`,
  });
});
after(async () => {
  globalThis.fetch = realFetch;
  for (const key of Object.keys(process.env)) if (key.startsWith("DB_BACKUP_STORE_")) delete process.env[key];
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

test("an unreadable upload directory cannot become a successful empty backup", async () => {
  await rm(uploads, { recursive: true, force: true });
  keys.length = 0;
  assert.equal((await runBackup(new Date("2026-09-29T20:10:00Z"))).uploaded, true);
  assert.equal(keys.length, 2, "an absent uploads directory is a valid empty archive");
  const [before] = await sql`SELECT value FROM settings WHERE key = 'backup.last'`;
  await symlink("uploads", uploads); // ELOOP, without depending on root/permission behavior
  keys.length = 0;
  await assert.rejects(runBackup(new Date("2026-09-29T20:11:00Z")), /ELOOP/);
  assert.equal(keys.length, 0, "do not send an empty archive as a replacement for unreadable files");
  const [after] = await sql`SELECT value FROM settings WHERE key = 'backup.last'`;
  assert.deepEqual(after, before, "last successful backup remains accurate");
});

test("a file archive that fails is reported in tar's own words, the database still shipped", async () => {
  await rm(uploads, { recursive: true, force: true });
  await mkdir(uploads);
  await writeFile(path.join(uploads, "screenshot.png"), "image");
  // tar cannot write its archive where a directory stands, on its first try or the second.
  await mkdir(path.join(config.dataDir, "backups", `${stem}-files-202609292012.tar.gz`), { recursive: true });
  keys.length = 0;
  await assert.rejects(runBackup(new Date("2026-09-29T20:12:00Z")), /the file archive failed: tar\b/);
  assert.deepEqual(keys.map((key) => path.basename(key)), [`${stem}-202609292012.dump`]);
  const [last] = await sql<{ value: { uploaded: boolean; filesError: string } }[]>`SELECT value FROM settings WHERE key = 'backup.last'`;
  assert.equal(last!.value.uploaded, false);
  assert.match(last!.value.filesError, /^tar\b/);
  assert.doesNotMatch(last!.value.filesError, /Command failed|-czf/, "the command line would crowd out the reason");
});
