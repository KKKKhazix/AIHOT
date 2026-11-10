// A run belongs to the OS process that started it, not to whichever worker happens to restart next.
// Birth identity distinguishes reused PIDs. Recovery only closes records; it never repeats work.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { audit } from "../audit.ts";
import { sql } from "../db.ts";

type RunOwner = { host: string; platform: string; pid: number; birth: string | null };
const exec = promisify(execFile);

function processGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    if (code === "EPERM") return false;
    throw error;
  }
}

/** null means the process exited; undefined means this host cannot establish its identity. */
async function processBirth(pid: number): Promise<string | null | undefined> {
  if (process.platform === "linux") {
    let boot: string;
    try { boot = await readFile("/proc/sys/kernel/random/boot_id", "utf8"); }
    catch (error) {
      if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
      throw error;
    }
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || fields[0] === "X") return null;
      if (!fields[19]) throw new Error(`cannot read process birth for ${pid}`);
      return `${boot.trim()}:${fields[19]}`;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return processGone(pid) ? null : undefined;
      if (code === "EACCES" || code === "EPERM") return undefined;
      throw error;
    }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await exec("ps", ["-p", String(pid), "-o", "lstart=,stat="], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
      const value = stdout.trim();
      const state = value.split(/\s+/).at(-1);
      return state?.startsWith("Z") ? null : value.replace(/\s+\S+$/, "");
    } catch (error) {
      if ((error as { code?: number }).code === 1) return processGone(pid) ? null : undefined;
      if (["EACCES", "EPERM", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
      throw error;
    }
  }
  return undefined;
}

let owner: Promise<RunOwner> | undefined;
export function runOwner(): Promise<RunOwner> {
  return owner ??= processBirth(process.pid).then(birth => ({ host: hostname(), platform: process.platform, pid: process.pid, birth: birth ?? null }));
}

/** No age threshold: a live API, CLI or host task keeps its runs even across a worker restart. */
export async function closeInterruptedRuns(): Promise<{ jobs: number; fetches: number }> {
  const local = await runOwner();
  if (!local.birth) return { jobs: 0, fetches: 0 };
  const owners = await sql<{ owner: RunOwner }[]>`
    SELECT DISTINCT detail->'owner' AS owner FROM (
      SELECT detail FROM job_runs WHERE status = 'running'
      UNION ALL SELECT detail FROM fetch_runs WHERE status = 'running'
    ) r WHERE detail->'owner'->>'host' = ${local.host} AND detail->'owner'->>'platform' = ${local.platform}
      AND detail->'owner'->>'birth' IS NOT NULL`;
  const result = { jobs: 0, fetches: 0 };
  for (const { owner } of owners) {
    const birth = await processBirth(owner.pid);
    if (birth === undefined || birth === owner.birth) continue;
    const reason = "执行进程已退出，未记录完成；仅结束运行记录，不重跑业务";
    await sql.begin(async tx => {
      for (const table of ["job_runs", "fetch_runs"] as const) {
        const rows = await tx`SELECT * FROM ${tx(table)} WHERE status = 'running' AND detail->'owner' = ${tx.json(owner as never)} FOR UPDATE`;
        for (const before of rows) {
          const [after] = await tx`UPDATE ${tx(table)} SET status = 'skipped', finished_at = now(), error = ${reason}
            WHERE id = ${before.id} AND status = 'running' RETURNING *`;
          await audit("ops.recover", "run.interrupted", `${table}:${before.id}`, reason, before, after, { db: tx });
        }
        result[table === "job_runs" ? "jobs" : "fetches"] += rows.length;
      }
    });
  }
  return result;
}
