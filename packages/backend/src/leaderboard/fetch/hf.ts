// Hugging Face dataset access: parquet files read at a pinned revision (hyparquet, pure JS).
import { parquetReadObjects } from "hyparquet";
import { guardedFetch } from "../../lib/http-fetch.ts";

export async function hfParquetRows<T>(dataset: string, revision: string, file: string): Promise<T[]> {
  const res = await guardedFetch(`https://huggingface.co/datasets/${dataset}/resolve/${revision}/${file}`, { timeoutMs: 120_000, maxBytes: 64 * 1024 * 1024, maxRedirects: 5 });
  if (res.status !== 200) throw new Error(`${dataset}/${file} HTTP ${res.status}`);
  const buf = res.body;
  // HTTP bodies larger than Node's small-buffer pool already own the complete backing buffer.
  // Reuse that allocation; pooled/subarray bodies still need their exact byte range copied.
  const fileBuffer = buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
    ? buf.buffer as ArrayBuffer
    : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const rows = await parquetReadObjects({ file: fileBuffer });
  // int64 columns arrive as BigInt; the values involved (ranks, counts) fit in a number.
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v]))) as T[];
}

export async function hfDatasetSha(dataset: string): Promise<string | null> {
  const res = await guardedFetch(`https://huggingface.co/api/datasets/${dataset}`, { timeoutMs: 30_000 });
  if (res.status !== 200) return null;
  return (JSON.parse(res.text()) as { sha?: string }).sha ?? null;
}
