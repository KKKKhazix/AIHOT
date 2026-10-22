import type { FastifyInstance } from "fastify";
import { sql } from "@aihot/backend/db";
import { defineServerModule } from "@aihot/backend/modules";
import { config } from "@aihot/backend/config";
import { chatJson } from "@aihot/backend/providers/llm";
import { z } from "zod";

const TRENDING_URL = "https://github.com/trending?since=daily";
const SOURCE_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

export interface GithubDailyItem {
  rank: number;
  repository: string;
  url: string;
  description: string;
  language: string | null;
  starsTotal: number;
  starsToday: number;
  aiSummary?: string | null;
}

const decode = (value: string) => value
  .replace(/<[^>]*>/g, " ")
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/\s+/g, " ").trim();

const number = (value: string) => Number((value.match(/[\d,]+/)?.[0] ?? "0").replace(/,/g, "")) || 0;

/** Extracts the stable, visible fields from GitHub's daily Trending HTML. */
export function parseTrendingHtml(html: string): GithubDailyItem[] {
  const out: GithubDailyItem[] = [];
  for (const match of html.matchAll(/<article\b[^>]*class="[^"]*Box-row[^"]*"[\s\S]*?<\/article>/gi)) {
    const article = match[0]!;
    const repoMatch = /<h2\b[\s\S]*?<a\b[^>]*href="\/([^"#?]+\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(article);
    if (!repoMatch) continue;
    const repository = repoMatch[1]!.replace(/\\u002F/g, "/").trim();
    const url = `https://github.com/${repository}`;
    const description = decode(/<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(article)?.[1] ?? "");
    const language = decode(/itemprop="programmingLanguage"[^>]*>([\s\S]*?)<\//i.exec(article)?.[1] ?? "") || null;
    const starsTotal = number(decode(/href="\/[^"]+\/stargazers"[^>]*>([\s\S]*?)<\/a>/i.exec(article)?.[1] ?? ""));
    const starsToday = number(/([\d,]+)\s+stars today/i.exec(decode(article))?.[1] ?? "");
    out.push({ rank: out.length + 1, repository, url, description, language, starsTotal, starsToday });
  }
  return out;
}

function today(): string {
  return SOURCE_DATE.format(new Date());
}

export async function fetchTrending(): Promise<GithubDailyItem[]> {
  const response = await fetch(TRENDING_URL, {
    headers: { "user-agent": "cocoHotBot/1.0", accept: "text/html" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`GitHub Trending returned ${response.status}`);
  const items = parseTrendingHtml(await response.text());
  if (!items.length) throw new Error("GitHub Trending returned no repositories");
  return items;
}

export async function refreshGithubDaily(snapshotDate = today()): Promise<GithubDailyItem[]> {
  const items = await fetchTrending();
  const enriched = await Promise.all(items.map(async (item) => ({ ...item, aiSummary: await summarize(item) })));
  await sql.begin(async (tx) => {
    await tx`DELETE FROM github_daily_snapshots WHERE snapshot_date = ${snapshotDate}::date`;
    for (const item of enriched) {
      await tx`
        INSERT INTO github_daily_snapshots (snapshot_date, rank, repository, url, description, language, stars_total, stars_today, ai_summary)
        VALUES (${snapshotDate}::date, ${item.rank}, ${item.repository}, ${item.url}, ${item.description}, ${item.language}, ${item.starsTotal}, ${item.starsToday}, ${item.aiSummary})`;
    }
  });
  return enriched;
}

async function summarize(item: GithubDailyItem): Promise<string | null> {
  const fallback = fallbackSummary(item);
  if (!config.modelCallsEnabled) return fallback;
  try {
    const result = await chatJson({
      model: "default", purpose: "github_daily_summary", subject: item.repository, promptVersion: "github-daily-summary-v1",
      system: "你是技术资讯编辑。根据 GitHub 仓库名和简介，用简体中文写一句不超过 26 个汉字的用途说明。只描述它大概解决什么问题，不夸大，不加序号，不使用 Markdown。",
      user: `仓库：${item.repository}\n语言：${item.language ?? "未标注"}\n简介：${item.description || "无"}`,
      schema: z.object({ summary: z.string().min(1).max(80) }), temperature: 0.2, maxTokens: 120,
    });
    return result.data.summary.trim();
  } catch {
    return fallback;
  }
}

function fallbackSummary(item: GithubDailyItem): string {
  const key = item.repository.toLowerCase();
  if (key === "php/php-src") return "PHP 编程语言的官方源码实现";
  if (key.includes("knowledge-work-plugins")) return "面向知识工作者的智能体插件集合";
  if (key.includes("security-audit-skill")) return "为代码智能体提供多阶段安全审计能力";
  if (key.includes("ponytail")) return "帮助 AI 智能体减少不必要的代码编写";
  if (key.includes("graphify")) return "把代码库和文档转换为可查询知识图谱";
  if (key === "supabase/supabase") return "面向 Web、移动端和 AI 应用的 Postgres 平台";
  if (key === "fastapi/fastapi") return "高性能、易上手的 Python Web API 框架";
  if (key.includes("claude-howto")) return "用实例介绍 Claude Code 与智能体开发";
  if (key.endsWith("/pcl")) return "Windows 平台的 Minecraft 启动器";
  return item.description.slice(0, 34) || "开源技术项目";
}

async function readSnapshot(snapshotDate: string): Promise<GithubDailyItem[]> {
  const rows = await sql<{ rank: number; repository: string; url: string; description: string; language: string | null; stars_total: number; stars_today: number; ai_summary: string | null }[]>`
    SELECT rank, repository, url, description, language, stars_total, stars_today, ai_summary
    FROM github_daily_snapshots WHERE snapshot_date = ${snapshotDate}::date ORDER BY rank`;
  return rows.map((row) => ({ rank: row.rank, repository: row.repository, url: row.url, description: row.description, language: row.language, starsTotal: row.stars_total, starsToday: row.stars_today, aiSummary: row.ai_summary }));
}

function registerHttp(app: FastifyInstance) {
  app.get("/api/github-daily", async (_request, reply) => {
    const snapshotDate = today();
    let items = await readSnapshot(snapshotDate);
    if (!items.length) items = await refreshGithubDaily(snapshotDate);
    return reply.header("Cache-Control", "public, s-maxage=300").send({ date: snapshotDate, sourceUrl: TRENDING_URL, items });
  });
}

export default defineServerModule({
  name: "github-daily",
  http: registerHttp,
  schedules: [{ name: "github-daily.snapshot", cron: "10 8 * * *", missed: "once", run: () => refreshGithubDaily() }],
});
