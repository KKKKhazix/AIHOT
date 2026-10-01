import { SITE, withSubject } from "@aihot/industry/site";
import { Link, data, useLoaderData } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/leaderboard";
import type { LbBoardResponse } from "@aihot/contracts/leaderboard";
import { loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta, siteUrl, titled } from "../lib/seo";
import { BoardTable } from "../features/leaderboard/BoardTable";
import { Podium } from "../features/leaderboard/Podium";
import { IconInfo } from "../components/icons";
import { PillToggles } from "../components/ui/Tabs";
import { modelHref, shortStamp } from "../features/leaderboard/format";
import { useEntrance } from "../lib/hydration";

const CATEGORY_KEYS = new Set(["coding", "reasoning", "knowledge", "professional"]);

export async function loader({ params, request }: Route.LoaderArgs) {
  const key = params.key ?? "overall";
  if (params.key !== undefined && !CATEGORY_KEYS.has(params.key)) throw data({ message: "not_found" }, { status: 404 });
  return loadOr404<LbBoardResponse>(`/api/site/leaderboard/boards/${key}`, { signal: request.signal });
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("页面不存在") }];
  const { board, entries } = loaderData;
  const path = board.key === "overall" ? "/leaderboard" : `/leaderboard/category/${board.key}`;
  return pageMeta({
    title: board.title,
    rawTitle: true,
    description: board.key === "overall" ? `汇总多家公开模型评测榜单，给出 ${SITE.name} 共识分、评测完整度、上线日期与 API 参考价格。` : board.description,
    path,
    image: "/og/pages/leaderboard.png",
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: board.key === "overall" ? `${SITE.name} 大模型综合榜` : `${SITE.name} ${board.name}模型榜`,
        itemListOrder: "https://schema.org/ItemListOrderAscending",
        numberOfItems: entries.length,
        itemListElement: entries.map((e) => ({ "@type": "ListItem", position: e.rank, name: e.model.name, url: `${siteUrl()}${modelHref(e.model.slug)}` })),
      },
      breadcrumbLd(
        board.key === "overall"
          ? [{ name: "模型榜", path: "/leaderboard" }]
          : [{ name: "模型榜", path: "/leaderboard" }, { name: `${board.name}榜`, path }],
      ),
    ],
  });
}

export function headers() {
  return { "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=600" };
}

export default function LeaderboardPage() {
  const { board, entries, filterEntries, pending, run } = useLoaderData<typeof loader>();
  const [filters, setFilters] = useState<string[]>([]);
  const domestic = filters.includes("domestic");
  const openWeights = filters.includes("open-weights");
  const filtered = filters.length > 0;
  const shown = filtered ? [...entries, ...(filterEntries ?? [])]
    .filter((e) => (!domestic || e.access?.domestic) && (!openWeights || !!e.access?.weightsUrl)).slice(0, 30) : entries;
  const entrance = useEntrance();
  return (
    <div key={board.key} className={entrance ? "animate-fade-up" : undefined}>
      <div className="mt-3 flex flex-col gap-1 lg:flex-row lg:items-center lg:justify-between">
        <p className="text-[13.5px] text-ink-2">{board.description}</p>
        <p className="num text-[12px] text-ink-4">
          {board.sourceCount} 项评测<span className="mx-2">·</span>
          {board.operatorCount} 家机构<span className="mx-2">·</span>
          {shortStamp(run.generatedAt)} 更新
        </p>
      </div>

      {!filtered && <Podium entries={entries} board={board.key} />}

      <section className="card mt-3 overflow-hidden" aria-labelledby="lb-board-title">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 lg:px-[22px]">
          <h2 id="lb-board-title" className="text-[16px] font-bold text-ink">
            {board.key === "overall" ? "综合榜" : `${board.name}榜`}
            <span className="mono ml-2 text-[11px] font-normal tracking-wide text-ink-4">{filtered ? `${shown.length} 个模型` : `TOP ${entries.length}`}</span>
          </h2>
          <PillToggles
            label="筛选模型"
            items={[{ key: "domestic", label: "国产厂商" }, { key: "open-weights", label: "开放权重" }]}
            selected={filters}
            onChange={setFilters}
          />
        </div>
        {shown.length ? <BoardTable entries={shown} board={board.key} /> : <p role="status" className="border-t border-line px-5 py-10 text-center text-[14px] text-ink-3">当前榜单暂无符合条件的模型。</p>}
        <div className="border-t border-line px-4 py-3 text-[12px] leading-relaxed text-ink-4 lg:px-[22px]">
          {!filtered && pending.length > 0 && <p className="mb-1 text-ink-3">
            综合榜前十中暂未进入{board.name}榜：{pending.map((p, i) => <span key={p.model.slug}>
              {i > 0 && "、"}<Link to={`/leaderboard/${p.model.slug}`} className="font-medium text-ink-2 hover:text-accent">{p.model.name}</Link>（已有 {p.sources} 项{board.name}评测）
            </span>)}。分类榜只比较测过同类评测的模型。
          </p>}
          <p>按多项公开评测的共同证据排名。每个榜单或筛选结果最多展示 30 个模型，筛选后保留原榜名次与分数。</p>
          {filtered && <p>国产厂商按模型开发方归属筛选，不代表所有版本均可在国内直接使用。开放权重仅收录已核验的官方权重，使用许可与部署要求请查看权重页面。</p>}
          <p>共识指数不是正确率；同分仍按共同证据确定的名次展示。</p>
        </div>
      </section>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <section className="card p-5">
          <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
            <IconInfo size={16} className="text-accent" />
            如何看这张榜
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{board.howToRead}价格不参与排名，缺测不记零分，指数不是正确率。</p>
          <Link to="/leaderboard/rules" className="mt-2.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:text-accent-ink">
            了解计算方法 →
          </Link>
        </section>
        <section className="card p-5">
          <h2 className="text-[14px] font-semibold text-ink">关于价格</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
            API 价格来自厂商官网，按每百万 Token 展示。{run.fx ? `美元报价按 ${run.fx.asOf} 汇率折算成人民币。` : ""}缓存价格指命中后的输入价格，缓存写入、存储及订阅费用另计。
          </p>
        </section>
      </div>
    </div>
  );
}
