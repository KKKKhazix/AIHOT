// Backfills one daily issue (operations helper). It composes the issue for one Beijing date with the
// same rule the scheduled run uses (reports/compose.ts composeDaily), and stores it. Existing rows are
// backed up to .data/report-backups before a regeneration, so a manual run never loses what readers
// already had.
//
// node --env-file=.env --experimental-strip-types scripts/compose-report.ts --date YYYY-MM-DD [--dry-run]
//
// --dry-run reads the day's window and prints what would be written; it never touches the table.
// It exits 0 whenever the real run would write an issue (including a quiet or a silent one).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { composeDaily, dailySilence } from "@aihot/backend/reports/compose";
import { arrangeDaily, dailyEdition } from "@aihot/backend/reports/edition";
import { beijingAt, beijingDate } from "@aihot/contracts/time";
import { EDITION_TIMES } from "@aihot/site";

const BACKUP_DIR = path.join(config.dataDir, "report-backups");

/** The stored JSON of a daily report (only what a regeneration needs to keep). */
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
  const opts = { date: "", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--date") {
      opts.date = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--dry-run") opts.dryRun = true;
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
    // A window with no entries still writes a real issue (a quiet or a silent one), so a dry run is
    // successful there too: exit 0, and `silence` says which issue the real run would write.
    const edition = await dailyEdition(opts.date, start, end);
    const issue = arrangeDaily(edition.entries);
    const silence = dailySilence(edition);
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
      wouldWrite: true,
      silence,
      reason: silence === "silent"
        ? `窗口内有 ${edition.stats.publishedReports ?? 0} 篇发布、0 判定：真跑会写静默版（与真跑一致，exit 0）`
        : silence === "quiet" ? "窗口内 0 篇发布：正常安静日，真跑会写安静版（与真跑一致，exit 0）" : null,
    }));
  } else {
    const backup = existing ? await backupIssue(opts.date, existing) : null;
    // A resident row means an explicit regeneration: pass a reason so saveReport keeps the old one as a revision.
    const result = await composeDaily(opts.date, existing ? "手动补跑（scripts/compose-report.ts）" : undefined);
    const row = await savedIssue(opts.date);
    if (!row) throw new Error(`daily ${opts.date}: composed but not stored`);
    console.log(JSON.stringify({
      date: opts.date,
      totalEntries: result.entries,
      flashes: row.content.flashes?.length ?? 0,
      sections: row.content.sections.length,
      revision: row.revision,
      backup,
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
