// Database and file backups: a verified custom-format dump plus the uploaded files, sent
// to the existing object store (Tencent COS through its S3-compatible API, AWS Signature V4) under
// daily/ (Sundays also weekly/, the 1st also monthly/). A few local copies are kept.
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config, credential } from "../config.ts";
import { sql } from "../db.ts";
import { screenshotsForwarded } from "./feedback.ts";

const run = promisify(execFile);
const KEEP_LOCAL = 3;

interface Store {
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  endpoint: string;
}

/** Backups run where the object store is configured (production); development never uploads. */
export function backupConfigured(): boolean {
  return store() !== null;
}

function store(): Store | null {
  const get = (k: string) => process.env[k] || credential("integrations", k) || null;
  const secretId = get("DB_BACKUP_STORE_SECRET_ID");
  const secretKey = get("DB_BACKUP_STORE_SECRET_KEY");
  const bucket = get("DB_BACKUP_STORE_BUCKET");
  const region = get("DB_BACKUP_STORE_REGION");
  if (!secretId || !secretKey || !bucket || !region) return null;
  const domain = get("DB_BACKUP_STORE_DOMAIN");
  return { secretId, secretKey, bucket, region, endpoint: domain ? `https://${domain.replace(/^https?:\/\//, "")}` : `https://${bucket}.cos.${region}.myqcloud.com` };
}

const hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** AWS Signature V4 headers for one S3 request. */
function signV4(opts: {
  method: string; url: URL; region: string; accessKey: string; secretKey: string; payloadHash: string; headers?: Record<string, string>;
}): Record<string, string> {
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const service = "s3";
  const headers: Record<string, string> = { ...(opts.headers ?? {}), host: opts.url.host, "x-amz-content-sha256": opts.payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalQuery = [...opts.url.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const canonicalPath = opts.url.pathname.split("/").map((s) => encodeURIComponent(decodeURIComponent(s))).join("/");
  const canonical = [opts.method, canonicalPath, canonicalQuery, names.map((n) => `${n}:${lower[n]}\n`).join(""), names.join(";"), opts.payloadHash].join("\n");
  const scope = `${day}/${opts.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.secretKey}`, day), opts.region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

async function fileSha256(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function upload(s: Store, key: string, file: string, sha: string, size: number) {
  const url = new URL(`${s.endpoint}/${key}`);
  const headers = signV4({ method: "PUT", url, region: s.region, accessKey: s.secretId, secretKey: s.secretKey, payloadHash: sha, headers: { "content-length": String(size), "content-type": "application/octet-stream" } });
  const res = await fetch(url, { method: "PUT", headers, body: createReadStream(file) as never, duplex: "half", signal: AbortSignal.timeout(60 * 60_000) } as RequestInit);
  if (!res.ok) throw new Error(`backup upload ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

export async function runBackup(now = new Date()) {
  const s = store();
  const dir = path.join(config.dataDir, "backups");
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  // Named after the database ("news_db" → news-db-…), so two databases backed up into one store stay apart.
  const name = sql.options.database.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const dump = path.join(dir, `${name}-${stamp}.dump`);
  await run("pg_dump", ["--format=custom", "--compress=6", "--no-owner", "--file", dump, config.databaseUrl], { maxBuffer: 16 * 1024 * 1024 });
  // Verify before shipping: the archive must list cleanly.
  await run("pg_restore", ["--list", dump], { maxBuffer: 64 * 1024 * 1024 });
  const files = path.join(dir, `${name}-files-${stamp}.tar.gz`);
  // An empty archive only when there is nothing to keep. A failure to read or pack existing files is
  // tried once more and otherwise reported: the database dump still ships, but the run fails.
  const kept: string[] = [];
  // Feedback screenshots only waiting to be forwarded are not kept (once forwarded, only the Feishu image
  // key remains). Without the internal chat they stay here for good, referred to as local: files.
  for (const d of screenshotsForwarded() ? ["uploads"] : ["uploads", "feedback-screenshots"]) {
    const info = await stat(path.join(config.dataDir, d)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    if (!info.isDirectory()) throw new Error(`backup ${d} path is not a directory`);
    kept.push(d);
  }
  let filesError: string | null = null;
  if (!kept.length) await run("tar", ["-czf", files, "-T", "/dev/null"]);
  else {
    const pack = () => run("tar", ["-czf", files, "-C", config.dataDir, ...kept]);
    await pack().catch(() => pack()).catch((error: unknown) => {
      // tar's own words: the message starts with the whole command line, which can fill the excerpt.
      const stderr = (error as { stderr?: unknown })?.stderr;
      filesError = String(typeof stderr === "string" && stderr.trim() ? stderr.trim() : error instanceof Error ? error.message : error).slice(0, 300);
    });
  }
  const out: Array<{ key: string; bytes: number; sha256: string }> = [];
  const bj = new Date(now.getTime() + 8 * 3600_000);
  const prefixes = ["daily"];
  if (bj.getUTCDay() === 0) prefixes.push("weekly");
  if (bj.getUTCDate() === 1) prefixes.push("monthly");
  for (const file of filesError ? [dump] : [dump, files]) {
    const size = (await stat(file)).size;
    const sha = await fileSha256(file);
    for (const p of prefixes) {
      // One prefix per retention class (daily/, weekly/, monthly/): a store's lifecycle rules can expire
      // each on its own schedule.
      const key = `${p}/${path.basename(file)}`;
      if (s) await upload(s, key, file, sha, size);
      out.push({ key: s ? key : `local-only:${path.basename(file)}`, bytes: size, sha256: sha });
    }
  }
  // Local copies: keep the newest few of each kind.
  for (const kind of [`${name}-2`, `${name}-files-`]) {
    const list = (await readdir(dir)).filter((f) => f.startsWith(kind)).sort().reverse();
    for (const f of list.slice(KEEP_LOCAL)) await rm(path.join(dir, f), { force: true });
  }
  const summary = { at: now.toISOString(), uploaded: !!s && !filesError, objects: out, ...(filesError ? { filesError } : {}) };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES ('backup.last', ${sql.json(summary as never)}, 'backup')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  if (!s) throw new Error("backup made locally but not uploaded: object store credentials are not configured");
  if (filesError) throw new Error(`database backed up, but the file archive failed: ${filesError}`);
  return summary;
}
