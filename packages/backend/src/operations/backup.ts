// Database and file backups: a verified custom-format dump plus the uploaded files, sent
// to the existing object store (Tencent COS through its S3-compatible API, AWS Signature V4) under
// one retention prefix: monthly/ on the 1st, otherwise weekly/ on Sundays or daily/.
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { beijingDate, beijingWeekday } from "@aihot/contracts/time";
import { config } from "../config.ts";
import { sql } from "../db.ts";
import { screenshotsForwarded } from "./feedback.ts";

const run = promisify(execFile);
const KEEP_LOCAL = 3;

export interface Store {
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

/** The object store, from the environment (backend.env); named one by one so the template check sees them. */
function store(): Store | null {
  const secretId = process.env.DB_BACKUP_STORE_SECRET_ID;
  const secretKey = process.env.DB_BACKUP_STORE_SECRET_KEY;
  const bucket = process.env.DB_BACKUP_STORE_BUCKET;
  const region = process.env.DB_BACKUP_STORE_REGION;
  if (!secretId || !secretKey || !bucket || !region) return null;
  const domain = process.env.DB_BACKUP_STORE_DOMAIN;
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

const EMPTY_SHA = hex("");
/** One part per request: 64 MB keeps a slow link from holding one open long enough to be cut. */
const PART_SIZE = 64 * 1024 * 1024;
/** Below this a single PUT is cheaper than three requests and just as reliable. */
const MULTIPART_FROM = 100 * 1024 * 1024;
const ATTEMPTS = 3;

/** One S3 request, tried again on the transient answers a long upload meets. */
async function request(url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) } as RequestInit);
      if (res.ok || res.status < 500 && res.status !== 429) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (error) {
      last = error;
    }
    if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** The bytes of one part, buffered so it can be signed and retried. */
async function readPart(file: string, start: number, length: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(file, { start, end: start + length - 1 })) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Upload one file. A dump can outgrow what a single PUT survives: on a slow link the store answers 502
 * or drops the connection halfway, so above MULTIPART_FROM the file goes up in parts, each retried on
 * its own.
 */
export async function upload(
  s: Store, key: string, file: string, sha: string, size: number,
  limits: { partSize?: number; threshold?: number } = {},
): Promise<void> {
  const url = new URL(`${s.endpoint}/${key}`);
  if (size < (limits.threshold ?? MULTIPART_FROM)) {
    const headers = signV4({ method: "PUT", url, region: s.region, accessKey: s.secretId, secretKey: s.secretKey, payloadHash: sha, headers: { "content-length": String(size), "content-type": "application/octet-stream" } });
    const res = await fetch(url, { method: "PUT", headers, body: createReadStream(file) as never, duplex: "half", signal: AbortSignal.timeout(60 * 60_000) } as RequestInit);
    if (!res.ok) throw new Error(`backup upload ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return;
  }

  const partSize = limits.partSize ?? PART_SIZE;
  const sign = (method: string, target: URL, payloadHash: string, headers: Record<string, string>) =>
    signV4({ method, url: target, region: s.region, accessKey: s.secretId, secretKey: s.secretKey, payloadHash, headers });

  // 1. Where the parts go.
  const create = new URL(url);
  create.searchParams.set("uploads", "");
  const created = await request(create, { method: "POST", headers: sign("POST", create, EMPTY_SHA, {}), body: "" }, 60_000);
  const uploadId = created.ok ? /<UploadId>([^<]+)<\/UploadId>/.exec(await created.text())?.[1] : undefined;
  if (!uploadId) throw new Error(`backup multipart ${key}: could not start (HTTP ${created.status})`);
  const abort = () => {
    const target = new URL(url);
    target.searchParams.set("uploadId", uploadId);
    void fetch(target, { method: "DELETE", headers: sign("DELETE", target, EMPTY_SHA, {}) }).catch(() => {});
  };

  try {
    // 2. The parts, one request each.
    const parts: Array<{ number: number; etag: string }> = [];
    for (let number = 1, offset = 0; offset < size; number++, offset += partSize) {
      const length = Math.min(partSize, size - offset);
      const body = await readPart(file, offset, length);
      const target = new URL(url);
      target.searchParams.set("partNumber", String(number));
      target.searchParams.set("uploadId", uploadId);
      const headers = sign("PUT", target, hex(body), { "content-length": String(length), "content-type": "application/octet-stream" });
      const res = await request(target, { method: "PUT", headers, body: body as never }, 10 * 60_000);
      const etag = res.headers.get("etag");
      if (!res.ok || !etag) throw new Error(`backup multipart ${key} part ${number}: HTTP ${res.status}${etag ? "" : " without an ETag"}`);
      parts.push({ number, etag });
    }
    // 3. The store joins the parts only when every ETag is listed back.
    const xml = `<CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.number}</PartNumber><ETag>${p.etag}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
    const complete = new URL(url);
    complete.searchParams.set("uploadId", uploadId);
    const headers = sign("POST", complete, hex(xml), { "content-length": String(Buffer.byteLength(xml)), "content-type": "application/xml" });
    const res = await request(complete, { method: "POST", headers, body: xml }, 60_000);
    const answer = await res.text();
    // A complete may answer 200 and put the failure in the body; the status alone reads as success.
    if (!res.ok || /<Error[\s>]/.test(answer)) {
      const code = /<Code>([^<]+)<\/Code>/.exec(answer)?.[1];
      throw new Error(`backup multipart ${key}: HTTP ${res.status}${code ? ` ${code}` : ""} ${answer.slice(0, 300)}`);
    }
  } catch (error) {
    abort();
    throw error;
  }
}

export async function runBackup(now = new Date()) {
  const s = store();
  const dir = path.join(config.dataDir, "backups");
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  // Named after the database ("news_db" → news-db-…), so two databases backed up into one store stay apart.
  const name = sql.options.database.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const dump = path.join(dir, `${name}-${stamp}.dump`);
  // execFile includes argv in failures. Give libpq credentials through its environment so neither
  // process listings nor a failed job's stored error contain them; keep other connection options.
  const connection = new URL(config.databaseUrl);
  const env = { ...process.env,
    ...(connection.username ? { PGUSER: decodeURIComponent(connection.username) } : {}),
    ...(connection.password ? { PGPASSWORD: decodeURIComponent(connection.password) } : {}),
  };
  connection.username = connection.password = "";
  // libpq decodes percent escapes but not form-style '+'. Keep non-credential options byte-for-byte.
  connection.search = connection.search.slice(1).split("&").filter(option => {
    const separator = option.indexOf("=");
    const key = decodeURIComponent(option.slice(0, separator));
    if (key !== "user" && key !== "password") return true;
    env[key === "user" ? "PGUSER" : "PGPASSWORD"] = decodeURIComponent(option.slice(separator + 1));
    return false;
  }).join("&");
  await run("pg_dump", ["--format=custom", "--compress=6", "--no-owner", "--file", dump, connection.href], { env, maxBuffer: 16 * 1024 * 1024 });
  // Verify before shipping: the archive must list cleanly.
  await run("pg_restore", ["--list", dump], { maxBuffer: 64 * 1024 * 1024 });
  const files = path.join(dir, `${name}-files-${stamp}.tar.gz`);
  // No archive when there are no attachments. A failure to read or pack existing files is
  // tried once more and otherwise reported: the database dump still ships, but the run fails.
  const kept: string[] = [];
  // Feedback screenshots only waiting to be forwarded are not kept (once forwarded, only the Feishu image
  // key remains). Without the internal chat they stay here for good, referred to as local: files.
  let filesError: string | null = null;
  try {
    for (const d of screenshotsForwarded() ? ["uploads"] : ["uploads", "feedback-screenshots"]) {
      const info = await stat(path.join(config.dataDir, d)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!info) continue;
      if (!info.isDirectory()) throw new Error(`backup ${d} path is not a directory`);
      if ((await readdir(path.join(config.dataDir, d), { recursive: true, withFileTypes: true })).some(entry => !entry.isDirectory())) kept.push(d);
    }
    if (kept.length) {
      const pack = () => run("tar", ["-czf", files, "-C", config.dataDir, ...kept]);
      await pack().catch(() => pack());
    }
  } catch (error: unknown) {
    // tar's own words: the message starts with the whole command line, which can fill the excerpt.
    const stderr = (error as { stderr?: unknown })?.stderr;
    filesError = String(typeof stderr === "string" && stderr.trim() ? stderr.trim() : error instanceof Error ? error.message : error).slice(0, 300);
  }
  const out: Array<{ key: string; bytes: number; sha256: string }> = [];
  const today = beijingDate(now);
  const prefix = today.endsWith("-01") ? "monthly" : beijingWeekday(today) === "星期日" ? "weekly" : "daily";
  for (const file of kept.length && !filesError ? [dump, files] : [dump]) {
    const size = (await stat(file)).size;
    const sha = await fileSha256(file);
    // One upload per file; the chosen prefix carries its retention class.
    const key = `${prefix}/${path.basename(file)}`;
    if (s) await upload(s, key, file, sha, size);
    out.push({ key: s ? key : `local-only:${path.basename(file)}`, bytes: size, sha256: sha });
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
