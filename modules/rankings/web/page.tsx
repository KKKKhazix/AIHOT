import { useMemo, useState } from "react";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";
import { navUp } from "@aihot/web/components/shell/nav";
import { cachedPage, loadOr404, pageHeaders } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import type { Ranking } from "../backend/publication.ts";
import type { RankingJudgement } from "../backend/screen.ts";
import type { Entry } from "../backend/tunbang.ts";

export const handle: Screen = { tab: navUp("/hot").tab, name: "榜单大全" };
export const headers = pageHeaders;
export async function loader({ request }: { request: Request }) {
  const data = await loadOr404<{ boards: Ranking[] }>("/api/site/rankings", { signal: request.signal });
  return cachedPage(60, { ...data, now: Date.now() });
}
export function meta() { return pageMeta({ title: "榜单大全", description: "浏览各平台热榜与公众号榜单。", path: "/rankings" }); }

function formatTime(value: string | null) {
  if (!value) return "暂无";
  const d = new Date(value); return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

function RankingRow({ item, judgement }: { item: Entry; judgement?: RankingJudgement }) {
  const level = judgement?.level;
  const color = level === "A" ? "text-red-700 dark:text-red-400" : level === "B" ? "text-orange-700 dark:text-orange-400" : "text-ink";
  return <li className="flex items-start gap-4 py-4"><span className={`w-7 shrink-0 text-center text-base font-bold ${level === "A" || level === "B" ? color : item.rank <= 3 ? "text-accent" : "text-ink-4"}`}>{item.rank}</span><div className="min-w-0 flex-1">
    {level === "A" && <span className={`mr-2 text-xs font-semibold ${color}`}>A｜优先关注</span>}{level === "B" && <span className={`mr-2 text-xs font-semibold ${color}`}>B｜待看原文</span>}
    {item.url?.startsWith("/items/") ? <Link to={item.url} className={`break-words text-[15px] font-medium leading-6 ${color} hover:underline`}>{item.title}</Link> : item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer" className={`break-words text-[15px] font-medium leading-6 ${color} hover:underline`}>{item.title} ↗</a> : <span className={`break-words text-[15px] font-medium leading-6 ${color}`}>{item.title}</span>}
    {(item.origin || item.metrics) && <p className="mt-1 text-xs leading-5 text-ink-4">{[item.origin, item.metrics].filter(Boolean).join(" · ")}</p>}
    {judgement && (level === "A" || level === "B") && <details className="mt-1 text-xs leading-5 text-ink-3"><summary className="cursor-pointer">判断理由与提示</summary><p>{judgement.reason}</p>{judgement.caution && <p>{judgement.caution}</p>}{judgement.related_ranks.length > 0 && <p>可能相关序号：{judgement.related_ranks.join("、")}</p>}</details>}
  </div>{item.heat && <span className="shrink-0 text-xs text-ink-4">{item.heat}</span>}</li>;
}

export default function RankingsPage() {
  const { boards, now } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(""); const [choosing, setChoosing] = useState(false);
  const selected = boards.find(b => b.id === params.get("board")) ?? boards[0];
  const judgements = selected?.screenStatus === "complete" ? selected.judgements ?? [] : [];
  const byRank = new Map(judgements.map(j => [j.rank, j]));
  const priority = (selected?.items ?? []).filter(item => byRank.get(item.rank)?.title === item.title && byRank.get(item.rank)?.level === "A").sort((a, b) => a.rank - b.rank);
  const sources = useMemo(() => [...new Set(boards.map(b => b.source))], [boards]);
  const choose = (id: string) => { setParams({ board: id }); setChoosing(false); };
  return <div className="pb-12">
    <PhoneBar title="榜单大全" large back={{ to: "/hot", label: "热点" }} sub="浏览不同平台的热榜与公众号榜单" />
    <header className="hidden pb-6 pt-1 lg:block"><h1 className="text-[26px] font-bold text-ink">榜单大全</h1><p className="mt-2 text-[13.5px] text-ink-3">浏览不同平台的热榜与公众号榜单</p></header>
    <div className="mb-4 lg:hidden"><button type="button" aria-expanded={choosing} onClick={() => setChoosing(!choosing)} className="w-full rounded-card border border-line bg-surface px-4 py-3 text-left text-sm font-semibold text-ink">选择榜单 · {selected?.name ?? "暂无榜单"} <span className="float-right text-ink-4">{choosing ? "收起 ↑" : "展开 ↓"}</span></button></div>
    <div className="lg:grid lg:grid-cols-[230px_minmax(0,1fr)] lg:gap-5">
      <aside className={`${choosing ? "block" : "hidden"} mb-4 rounded-card border border-line bg-surface p-3 lg:sticky lg:top-5 lg:mb-0 lg:block lg:max-h-[calc(100vh-40px)] lg:self-start lg:overflow-y-auto`} aria-label="榜单列表">
        <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索榜单或来源" aria-label="搜索榜单或来源" className="w-full rounded-lg border border-line bg-bg px-3 py-2.5 text-sm text-ink outline-none focus:border-accent" />
        {sources.map(source => { const list = boards.filter(b => b.source === source && `${b.name} ${b.source}`.toLowerCase().includes(search.toLowerCase().trim())); if (!list.length) return null; return <details key={source} open className="mt-4"><summary className="cursor-pointer px-2 py-1 text-xs font-semibold text-ink-4">{source} · {list.length}</summary><div className="mt-1 space-y-0.5">{list.map(b => <button type="button" key={b.id} onClick={() => choose(b.id)} aria-current={selected?.id === b.id ? "true" : undefined} className={`w-full rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${selected?.id === b.id ? "bg-accent/10 font-semibold text-accent" : "text-ink-3 hover:bg-bg-sunk"}`}>{b.name}</button>)}</div></details>; })}
        {!boards.some(b => `${b.name} ${b.source}`.toLowerCase().includes(search.toLowerCase().trim())) && <p className="px-2 py-5 text-sm text-ink-4">没有找到匹配的榜单</p>}
      </aside>
      <main className="min-w-0 rounded-card border border-line bg-surface px-4 py-5 sm:px-6">
        {selected && <><div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-soft pb-5"><div><h2 className="text-xl font-bold text-ink">{selected.name}</h2><p className="mt-2 text-xs leading-5 text-ink-4">{selected.source === "家友榜" ? <>按发布时间筛选、评分排序 · 统计于 {formatTime(selected.fetchedAt)}</> : <>来源：{selected.source} · {selected.source === "今日热榜" ? "榜单日期" : "榜单更新"}：{selected.sourceUpdated ?? "暂无"} · 获取：{formatTime(selected.fetchedAt)}</>}</p></div>{selected.source === "家友榜" ? <Link to="/all" className="text-sm font-medium text-accent">查看全部动态 →</Link> : <a href={selected.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-accent">查看来源 ↗</a>}</div>
          {selected.source === "微小榜" && <p className="mt-4 text-xs leading-5 text-ink-4">{selected.id === "wxrank:account" ? "近 30 天" : "近 7 天"} · 显示来源匿名开放的前 50 条；其他周期和更多结果请前往来源查看。</p>}
          {selected.source !== "家友榜" && selected.fetchedAt && !selected.failed && now - new Date(selected.fetchedAt).getTime() > 2 * 60 * 60 * 1000 && <p className="mt-4 rounded-lg bg-bg-sunk px-3 py-2 text-sm text-ink-3">榜单已有较长时间未更新，正在显示上次获取的结果。</p>}
          {selected.failed && <p className="mt-4 rounded-lg bg-bg-sunk px-3 py-2 text-sm text-ink-3">更新失败{selected.fetchedAt ? "，正在显示上次获取的结果。" : "，暂时没有可显示的数据。"}</p>}
          {selected.source !== "家友榜" && selected.items.length > 0 && <section className="mt-5" aria-label="榜单线索判断">
            <h3 className="text-base font-semibold text-ink">优先关注</h3>
            <p className="mt-1 text-xs text-ink-4">按原榜单序号排列；榜单热度和线索判断不代表事实已核实。</p>
            {selected.screenStatus === "complete" ? priority.length ? <ol className="divide-y divide-line-soft">{priority.map((item, i) => <RankingRow key={`${item.rank}-${i}`} item={item} judgement={byRank.get(item.rank)} />)}</ol> : <p className="py-4 text-sm text-ink-3">本次未识别到直接相关内容。</p> : <p className="py-4 text-sm text-ink-3">{selected.screenStatus === "failed" ? "判断失败，原始榜单仍可查看。" : "判断中，原始榜单仍可查看。"}</p>}
          </section>}
          {selected.unavailable && <p className="mt-5 text-sm leading-7 text-ink-3">{selected.unavailable} <a href={selected.url} target="_blank" rel="noopener noreferrer" className="text-accent">前往来源查看 ↗</a></p>}
          {!selected.unavailable && !selected.items.length && !selected.failed && <p className="py-12 text-center text-sm text-ink-4">{selected.source === "家友榜" ? "这个时间范围内暂无有评分的公开动态。" : "暂无榜单数据，等待后台采集。"}</p>}
          {!!selected.items.length && <ol className="divide-y divide-line-soft">{selected.items.map((item, i) => <RankingRow key={`${item.rank}-${i}`} item={item} judgement={byRank.get(item.rank)?.title === item.title ? byRank.get(item.rank) : undefined} />)}</ol>}
        </>}
      </main>
    </div>
  </div>;
}
