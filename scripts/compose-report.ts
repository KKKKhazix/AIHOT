// Backfills one daily issue (operations helper). It composes the issue for one Beijing date with the
// same rule the scheduled run uses (reports/compose.ts composeDaily), stores it, and optionally pushes
// the briefing to the local WeChat bridge. Existing rows are backed up to .data/report-backups before
// a regeneration, so a manual run never loses what readers already had.
//
// node --env-file=.env --experimental-strip-types scripts/compose-report.ts --date YYYY-MM-DD [--dry-run] [--push]
//
// --dry-run reads the day's window and prints what would be written; it never touches the table.
// --push POSTs the composed briefing to 127.0.0.1:8199/push (WEIXIN_PUSH_URL overrides the address)
// and prints the bridge's messageId.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { composeDaily } from "@aihot/backend/reports/compose";
import { arrangeDaily, dailyEdition } from "@aihot/backend/reports/edition";
import { composeText } from "@aihot/wechat-push/server";
import { beijingAt, beijingDate } from "@aihot/contracts/time";
import { EDITION_TIMES } from "@aihot/site";

const PUSH_URL = process.env.WEIXIN_PUSH_URL ?? "http://127.0.0.1:8199/push";
const BACKUP_DIR = path.join(config.dataDir, "report-backups");

/** The briefing composeText reads; `content` is the stored JSON of a daily report. */
interface DailyContent {
  date: string;
  lead: { title: string; leadParagraph: string };
  sections: Array<{
    label?: string | null;
    items: Array<{ title: string; summary?: string | null; sourceName?: string | null; score?: number | null }>;
  }>;
  flashes?: Array<{ title: string }>;
  metrics?: { totalEvents?: number; sourcesCount?: number };
}

function parseArgs(argv: string[]) {
  const opts = { date: "", dryRun: false, push: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--date") {
      opts.date = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--push") opts.push = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error(`--date needs YYYY-MM-DD, got "${opts.date}"`);
  if (beijingDate(new Date(`${opts.date}T12:00:00+08:00`)) !== opts.date) throw new Error(`not a calendar date: ${opts.date}`);
  return opts;
}

/** The window composeDaily uses: the 24 hours up to the edition time on `date` (Beijing). */
function windowOf(date: string) {
  const end = beijingAt(date, EDITION_TIMES.daily);
  return { start: new Date(end.getTime() - 86_400_000), end };
}

async function savedIssue(date: string) {
  const [row] = await sql<{ revision: number; generated_at: Date; content: DailyContent }[]>`
    SELECT revision, generated_at, content FROM reports WHERE kind = 'daily' AND key = ${date}`;
  return row;
}

/** Writes the row a regeneration is about to replace to .data/report-backups; returns its path. */
async function backupIssue(date: string, row: { revision: number; generated_at: Date; content: DailyContent }) {
  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `daily-${date}-${stamp}.json`);
  await writeFile(file, `${JSON.stringify({ kind: "daily", key: date, ...row }, null, 2)}\n`);
  return file;
}

async function pushBriefing(content: DailyContent): Promise<string | null> {
  const daily = {
    date: content.date,
    lead: content.lead,
    sections: content.sections,
    flashes: content.flashes ?? [],
    metrics: content.metrics,
  };
  const text = composeText(daily, []);
  const res = await fetch(PUSH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => null)) as { sent?: boolean; messageId?: string; error?: { code?: string; message?: string } } | null;
  if (!res.ok || body?.sent !== true) {
    throw new Error(`weixin bridge failed: ${body?.error?.code ?? body?.error?.message ?? `http-${res.status}`}`);
  }
  return body.messageId ?? null;
}

let opts: ReturnType<typeof parseArgs>;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exit(2);
}
const { start, end } = windowOf(opts.date);
let exitCode = 0;

try {
  const existing = await savedIssue(opts.date);

  if (opts.dryRun) {
    // Same window and same builders as composeDaily, stopping before saveReport: nothing is written.
    const edition = await dailyEdition(opts.date, start, end);
    const issue = arrangeDaily(edition.entries);
    const failure = edition.entries.length === 0 && edition.stats.judgedReports === 0
      ? `daily ${opts.date}: nothing judged in its window`
      : null;
    console.log(JSON.stringify({
      date: opts.date,
      dryRun: true,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      existing: existing ? { revision: existing.revision, generatedAt: existing.generated_at } : null,
      entries: edition.entries.length,
      mainEntries: issue.main.length,
      flashes: issue.flashes.length,
      stats: edition.stats,
      wouldWrite: failure === null,
      reason: failure,
      ...(opts.push ? { push: "skipped: --dry-run does not send" } : {}),
    }));
    if (failure !== null) exitCode = 2;
  } else {
    const backup = existing ? await backupIssue(opts.date, existing) : null;
    // A resident row means an explicit regeneration: pass a reason so saveReport keeps the old one as a revision.
    const result = await composeDaily(opts.date, existing ? "手动补跑（scripts/compose-report.ts）" : undefined);
    const row = await savedIssue(opts.date);
    if (!row) throw new Error(`daily ${opts.date}: composed but not stored`);
    let messageId: string | null = null;
    let pushError: string | null = null;
    if (opts.push) {
      try {
        messageId = await pushBriefing(row.content);
      } catch (error) {
        pushError = error instanceof Error ? error.message : String(error);
        exitCode = 1;
      }
    }
    console.log(JSON.stringify({
      date: opts.date,
      totalEntries: result.entries,
      flashes: row.content.flashes?.length ?? 0,
      sections: row.content.sections.length,
      revision: row.revision,
      backup,
      pushRequested: opts.push,
      pushed: messageId !== null,
      messageId,
      pushError,
    }));
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ date: opts.date, error: message }));
  exitCode = 1;
} finally {
  await closeDb();
}

process.exitCode = exitCode;
