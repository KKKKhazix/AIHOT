// Reading OpenGithubs/github-weekly-rank: one Markdown file per week, published each Monday, holding the
// top 20 repositories by weekly star growth (with total stars, weekly and monthly growth, the open-source
// date and the project description). Upstream carries no licence, so this only reads and cites it: the text
// below states the facts and names the source, and the upstream file itself is never mirrored.
// What is read here: the "## YYYY.MM.DD 本周最佳开源项目" heading, the ranked summary table, and the
// per-project <h3> blocks that add the monthly growth, the open-source date and the description.

export interface Ranked {
  rank: number;
  /** "owner/repo". */
  repo: string;
  url: string;
  /** Upstream prints a rounded figure ("31.9k"). */
  starsText: string;
  weeklyDelta: number | null;
  monthlyDelta: number | null;
  /** The project's open-source date as upstream prints it (YYYY-MM-DD). */
  createdAt: string | null;
  /** The project's one-line description, quoted from the edition and attributed to it. */
  description: string | null;
}

export interface WeeklyRank {
  /** "2026/10/20261012.md", the path inside the repository. */
  file: string;
  /** The file's address on github.com, cited to readers. */
  sourceUrl: string;
  /** The Monday it was published (00:00 UTC, which is when upstream commits each edition). */
  publishedAt: Date;
  /** The week it covers, as upstream writes it ("2026.10.06"–"2026.10.11"). */
  window: { from: string; to: string } | null;
  items: Ranked[];
}

/** The repository the weekly file comes from. */
export const REPO = "OpenGithubs/github-weekly-rank";

/**
 * The Mondays to look for, newest first. Upstream names each file after the Monday it is published and
 * resolves its own "newest" by walking back up to six weeks; a week whose file is not out yet (the run
 * happens before the publication hour) falls back to the previous one, which is then already stored.
 */
export function candidateMondays(now: Date, weeks = 6): string[] {
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const out: string[] = [];
  for (let i = 0; i < weeks; i++) {
    const x = new Date(monday);
    x.setUTCDate(monday.getUTCDate() - i * 7);
    out.push(x.toISOString().slice(0, 10).replace(/-/g, ""));
  }
  return out;
}

/** The file path a Monday's edition lives at: "<YYYY>/<MM>/<YYYYMMDD>.md". */
export function filePathFor(day: string): string {
  return `${day.slice(0, 4)}/${day.slice(4, 6)}/${day}.md`;
}

export function sourceUrlFor(file: string): string {
  return `https://github.com/${REPO}/blob/main/${file}`;
}

/** The API address a file's bytes are read from. */
export function contentsApiUrl(file: string): string {
  return `https://api.github.com/repos/${REPO}/contents/${file}`;
}

/** "29362" out of "🔺29362" or "29,362"; null when the cell holds no digits. */
function toInt(value: string | undefined): number | null {
  const digits = String(value ?? "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

/** The week the edition covers, from its "2026.10.06-2026.10.11 周榜排行" line. */
function parseWindow(md: string): { from: string; to: string } | null {
  const m = /(\d{4}\.\d{2}\.\d{2})\s*-\s*(\d{4}\.\d{2}\.\d{2})\s*周榜排行/.exec(md);
  return m ? { from: m[1]!, to: m[2]! } : null;
}

/** The ranked summary table: | 1 | [owner/repo](url) | 31.9k | 🔺29362 | */
function parseTable(md: string): Ranked[] {
  const out: Ranked[] = [];
  for (const line of md.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells.length < 5) continue;
    const rank = Number(cells[1]);
    // Skips the header and its separator, whose second cell is not a rank.
    if (!Number.isInteger(rank) || rank < 1) continue;
    const link = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/.exec(cells[2]!);
    if (!link) continue;
    out.push({
      rank,
      repo: link[1]!.trim(),
      url: link[2]!.trim(),
      starsText: cells[3]!,
      weeklyDelta: toInt(cells[4]),
      monthlyDelta: null,
      createdAt: null,
      description: null,
    });
  }
  return out;
}

/**
 * The per-project blocks add the monthly growth, the open-source date and the description. Their headings
 * are not uniform (some carry a Chinese title before the URL), so each block is read on its own. The split
 * consumes the whole <h3 …> tag, leaving each block's text starting at its number.
 */
function parseDetails(md: string): Map<string, Pick<Ranked, "monthlyDelta" | "createdAt" | "description">> {
  const out = new Map<string, Pick<Ranked, "monthlyDelta" | "createdAt" | "description">>();
  for (const chunk of md.split(/<h3[^>]*>/).slice(1)) {
    const text = chunk.replace(/<[^>]+>/g, " ");
    const heading = text.split("\n")[0] ?? "";
    const head = /^\s*(\d+)\s*\.\s*[\s\S]*?https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/.exec(heading);
    if (!head) continue;
    out.set(head[2]!, {
      monthlyDelta: toInt(/上月增长数量[：:]\s*([\d,]+)/.exec(text)?.[1]),
      createdAt: /开源时间[：:]\s*([\d-]+)/.exec(text)?.[1] ?? null,
      description: (/项目描述[：:]\s*([^\n]+)/.exec(text)?.[1] ?? "").trim() || null,
    });
  }
  return out;
}

/**
 * Parses one weekly file. `day` is the Monday its name carries ("20261012"): upstream commits each edition
 * at 00:00 UTC that day (observed across editions), so that is the publication time.
 */
export function parseWeeklyRank(md: string, day: string): WeeklyRank {
  const file = filePathFor(day);
  const details = parseDetails(md);
  const items = parseTable(md).map((item) => ({ ...item, ...(details.get(item.repo) ?? {}) }));
  return {
    file,
    sourceUrl: sourceUrlFor(file),
    publishedAt: new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`),
    window: parseWindow(md),
    items,
  };
}

const THOUSANDS = new Intl.NumberFormat("en-US");
const DESCRIPTION_LIMIT = 100;

/** A one-line description cut to length at a word boundary, so the digest does not end mid-word. */
function shorten(text: string): string {
  if (text.length <= DESCRIPTION_LIMIT) return text;
  const cut = text.slice(0, DESCRIPTION_LIMIT);
  const at = cut.lastIndexOf(" ");
  return `${(at > DESCRIPTION_LIMIT / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** The week the edition covers, for a headline ("（2026.10.06–2026.10.11）"), or an empty string. */
function weekLabel(rank: WeeklyRank): string {
  return rank.window ? `（${rank.window.from}–${rank.window.to}）` : "";
}

/**
 * One project's headline. Every ranked project is its own item — a single fact ("this project grew this
 * much this week") that can be judged, selected, picked up by other sources and joined to their stories.
 * A list of twenty projects in one article is a composite and gets no event of its own.
 */
export function projectTitle(rank: WeeklyRank, item: Ranked): string {
  const growth = item.weeklyDelta === null ? "" : ` 单周 +${THOUSANDS.format(item.weeklyDelta)}★`;
  return `GitHub 周飙升榜${weekLabel(rank)}第 ${item.rank} 名：${item.repo}${growth}`;
}

/**
 * One project's facts as readers and the judging steps see them. Facts and attribution only — the upstream
 * file's own prose is never copied, and the repository carries no licence for redistribution. The text is
 * Chinese so the item stands on its own without a translation step.
 */
export function projectBody(rank: WeeklyRank, item: Ranked): string {
  const week = rank.window ? `覆盖 ${rank.window.from}–${rank.window.to}，` : "";
  const lines = [
    `GitHub 周飙升榜${weekLabel(rank)}第 ${item.rank} 名：${item.repo}。该榜由第三方按周 Star 净增量排名，${week}每周一发布。`,
    `- 总星数：${item.starsText}`,
  ];
  if (item.weeklyDelta !== null) lines.push(`- 本周新增：${THOUSANDS.format(item.weeklyDelta)} 星（本周第 ${item.rank} 名）`);
  if (item.monthlyDelta !== null) lines.push(`- 本月新增：${THOUSANDS.format(item.monthlyDelta)} 星`);
  if (item.createdAt) lines.push(`- 开源时间：${item.createdAt}`);
  if (item.description) lines.push(`- 项目简介：${shorten(item.description)}`);
  lines.push(`- 项目地址：${item.url}`);
  lines.push("榜单说明：该榜由第三方仓库 OpenGithubs/github-weekly-rank 按 Star 周净增量统计，与 github.com/trending 的排序口径不同，不是 GitHub 官方榜单。");
  lines.push(`本期原始文件：${rank.sourceUrl}`);
  return lines.join("\n");
}
