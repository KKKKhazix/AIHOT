// A missing uploads directory is a valid empty backup; an unreadable directory is not. Failure to
// inspect it must never upload an empty file archive and record a successful backup.
import "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { symlink } from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import { config } from "@aihot/backend/config";
import { sql, closeDb } from "@aihot/backend/db";
import { runBackup } from "@aihot/backend/operations/backup";

after(closeDb);

test("an unreadable upload directory cannot become a successful empty backup", async () => {
  const keys: string[] = [];
  const server = http.createServer((req, res) => {
    keys.push(req.url!);
    req.resume();
    req.on("end", () => res.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The upload transport is stubbed; pg_dump and pg_restore run against this file's isolated DB.
  const realFetch = globalThis.fetch;
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
  try {
    assert.equal((await runBackup(new Date("2026-09-29T20:10:00Z"))).uploaded, true);
    assert.equal(keys.length, 2, "an absent uploads directory is a valid empty archive");
    const [before] = await sql`SELECT value FROM settings WHERE key = 'backup.last'`;
    await symlink("uploads", path.join(config.dataDir, "uploads")); // ELOOP, without depending on root/permission behavior
    keys.length = 0;
    await assert.rejects(runBackup(new Date("2026-09-29T20:11:00Z")), /ELOOP/);
    assert.equal(keys.length, 0, "do not send an empty archive as a replacement for unreadable files");
    const [after] = await sql`SELECT value FROM settings WHERE key = 'backup.last'`;
    assert.deepEqual(after, before, "last successful backup remains accurate");
  } finally {
    globalThis.fetch = realFetch;
    for (const key of Object.keys(process.env)) if (key.startsWith("DB_BACKUP_STORE_")) delete process.env[key];
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
