import { useLoaderData } from "react-router";
import { apiGet, cachedPage, pageHeaders } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import { IconArrowUpRight, IconGithub } from "@aihot/web/components/icons";
import { ReportChannelTabs } from "@aihot/web/features/report/ReportChannelTabs";
import type { Screen } from "@aihot/web/components/shell/screens";

interface Item { rank: number; repository: string; url: string; description: string; language: string | null; starsTotal: number; starsToday: number; aiSummary?: string | null }
interface Response { date: string; sourceUrl: string; items: Item[] }

export const handle: Screen = { tab: "daily", name: "GitHub 日榜" };
export const headers = pageHeaders;

export async function loader({ request }: { request: Request }) {
  return cachedPage(300, { data: await apiGet<Response>("/api/github-daily", { signal: request.signal }) });
}

export function meta() {
  return pageMeta({ title: "GitHub 日榜", description: "每天更新的 GitHub Trending 仓库榜单。", path: "/github-daily" });
}

const format = (n: number) => n.toLocaleString("en-US");

function Rank({ rank }: { rank: number }) {
  return <span className={`mono text-[13px] font-bold tracking-[0.14em] ${rank <= 3 ? "text-accent" : "text-ink-4"}`}>NO.{String(rank).padStart(2, "0")}</span>;
}

export default function GithubDailyPage() {
  const { data } = useLoaderData<typeof loader>();
  const maxStarsToday = Math.max(...data.items.map((item) => item.starsToday), 1);
  return (
    <main className="mx-auto w-full max-w-[900px] px-4 pb-16 pt-8 sm:px-8 lg:pt-12">
      <ReportChannelTabs active="github" />
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-accent"><IconGithub size={16} /> GitHub Trending</div>
          <h1 className="mt-3 text-[30px] font-bold tracking-[-0.03em] text-ink sm:text-[38px]">GitHub 日榜</h1>
          <p className="mt-2 text-[14px] text-ink-3">按 24 小时 Star 增量排序 · 找到今天增长最快的开源项目</p>
        </div>
        <a href={data.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-accent hover:underline">查看 GitHub 原榜 <IconArrowUpRight size={15} /></a>
      </header>
      <section className="space-y-2.5" aria-label="GitHub Trending 日榜">
        {data.items.map((item) => (
          <article key={item.repository} className="card card-hover group relative flex items-center justify-between gap-5 px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2"><Rank rank={item.rank} /><span className="text-[12px] text-ink-4">{item.language ?? "未标注语言"}</span></div>
              <h2 className="mt-2 truncate text-[17px] font-bold text-ink sm:text-[19px]"><a href={item.url} target="_blank" rel="noreferrer" className="hover:text-accent">{item.repository}</a></h2>
              <p className="mt-1 truncate text-[13px] leading-6 text-ink-3">{item.aiSummary || item.description}</p>
              <div className="mt-1 text-[11px] text-ink-4">总 Stars {format(item.starsTotal)}</div>
            </div>
            <div className="w-[110px] shrink-0 text-right sm:w-[190px]">
              <div className="text-[22px] font-bold tracking-[-0.03em] text-[#79c900]">+{format(item.starsToday)}</div>
              <div className="mt-1.5 ml-auto h-1.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: "var(--line-strong)" }}><div className="h-full rounded-full" style={{ width: `${Math.max(8, item.starsToday / maxStarsToday * 100)}%`, backgroundColor: "#a3e635" }} /></div>
              <div className="mt-1 text-[10px] text-ink-4">今日新增 Stars</div>
            </div>
          </article>
        ))}
      </section>
      <p className="mt-8 text-[12px] leading-6 text-ink-4">榜单数据来自 GitHub Trending 页面，每天北京时间 08:10 更新。排名和 Stars 数会随 GitHub 页面变化。</p>
    </main>
  );
}
