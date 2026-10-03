import { Link, data, useLoaderData } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/leaderboard";
import type { LbBoardResponse } from "@aihot/contracts/leaderboard";
import { SITE } from "@aihot/industry/site";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta, siteUrl, titled } from "../lib/seo";
import { BoardTable, SORTS, type SortKey } from "../features/leaderboard/BoardTable";
import { IconCheck, IconFilter, IconInfo } from "../components/icons";
import { ToggleChip } from "../components/ui/Controls";
import { Sheet } from "../components/ui/Sheet";
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
    description: board.key === "overall" ? `汇总多家公开模型评测，展示 ${SITE.name} 评分、参考位次、分项成绩、上线日期与 API 参考价格。` : board.description,
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
  return edgeTtl(600);
}

export default function LeaderboardPage() {
  const { board, entries, filterEntries, pending, run } = useLoaderData<typeof loader>();
  const [domestic, setDomestic] = useState(false);
  const [openWeights, setOpenWeights] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "rank", dir: 1 });
  const [panel, setPanel] = useState(false);
  const filtered = domestic || openWeights;
  const clear = () => {
    setDomestic(false);
    setOpenWeights(false);
  };
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

      <section className="card mt-3 overflow-hidden" aria-labelledby="lb-board-title">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 lg:px-[22px]">
          <h2 id="lb-board-title" className="text-[16px] font-bold text-ink">
            {board.key === "overall" ? "综合榜" : `${board.name}榜`}
            <span className="mono ml-2 text-[11px] font-normal tracking-wide text-ink-4">{`${shown.length} 个模型`}</span>
          </h2>
          <div role="group" aria-label="筛选模型（可多选）" className="hidden items-center gap-2 lg:flex">
            {filtered && (
              <button type="button" onClick={clear} className="mr-1 text-[12.5px] text-ink-4 transition-colors hover:text-ink">
                清除
              </button>
            )}
            <ToggleChip on={domestic} onToggle={() => setDomestic((v) => !v)}>国产模型</ToggleChip>
            <ToggleChip on={openWeights} onToggle={() => setOpenWeights((v) => !v)}>开源模型</ToggleChip>
          </div>
          {/* Phones: the filters live in the panel with the orders. */}
          <div className="-my-1 flex items-center lg:hidden">
            {filtered && (
              <button type="button" onClick={clear} className="h-11 px-2.5 text-[13px] text-ink-4 active:opacity-50">
                清除
              </button>
            )}
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={() => setPanel(true)}
              className={`inline-flex h-11 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors active:scale-[0.98] ${filtered ? "border-accent/35 bg-accent-soft text-accent" : "border-line-strong bg-surface text-ink-2"}`}
            >
              <IconFilter size={16} />
              筛选
              {filtered && <span className="num">{Number(domestic) + Number(openWeights)}</span>}
            </button>
          </div>
        </div>
        {shown.length ? (
          <BoardTable entries={shown} board={board.key} sort={sort.key} dir={sort.dir} onSort={(key, dir) => setSort({ key, dir })} onSortSheet={() => setPanel(true)} />
        ) : (
          <p role="status" className="border-t border-line px-5 py-10 text-center text-[14px] text-ink-3">当前榜单暂无符合条件的模型。</p>
        )}
        <div className="border-t border-line px-4 py-3 text-[12px] leading-relaxed text-ink-4 lg:px-[22px]">
          {!filtered && pending.length > 0 && (
            <p className="mb-1 text-ink-3">
              {board.key === "overall" ? "分类榜已有领先成绩，但综合证据尚不足：" : `综合参考顺序前十中暂未进入${board.name}榜：`}
              {pending.map((p, i) => (
                <span key={p.model.slug}>
                  {i > 0 && "、"}
                  <Link viewTransition to={modelHref(p.model.slug, board.key)} className="font-medium text-ink-2 transition-colors hover:text-accent">{p.model.name}</Link>
                  （已有 {p.sources} 项可比评测）
                </span>
              ))}
              。{board.key === "overall" ? "尚无综合参考位次不等于能力较弱，仍可查看已有分类与原始成绩。" : "分类榜只比较测过同类评测的模型，通常需要两项、来自两家机构的评测。"}
            </p>
          )}
          <p>{SITE.name} 评分为 0–100 分，越高表示本榜综合表现越强。同分按参考位次排列；筛选后保留原榜评分与位次，每次最多展示 30 个模型。</p>
          {filtered && <p>国产模型按开发方归属筛选，不代表所有版本均可在国内直接使用。开源模型指已核验公开官方权重的模型，使用许可与部署要求请查看权重页面。</p>}
          <p>评分用于同一榜单、同一轮内的比较，不是正确率。各项评测的原始成绩可在模型详情查看。</p>
        </div>
      </section>

      {/* Phones: the orders on offer, each in its natural direction (choosing one closes the panel), and
          the filters, which may be combined. */}
      <Sheet open={panel} onClose={() => setPanel(false)} title="排序与筛选">
        <h3 className="px-5 pb-2 text-[12.5px] font-medium text-ink-4">排序</h3>
        <div role="radiogroup" aria-label="排序方式" className="mx-4 divide-y divide-line-soft overflow-hidden rounded-card ring-1 ring-inset ring-line">
          {SORTS.map((o) => {
            const on = sort.key === o.key;
            return (
              <button
                key={o.key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setSort({ key: o.key, dir: 1 });
                  setPanel(false);
                }}
                className={`flex h-12 w-full items-center justify-between px-4 text-left text-[16px] transition-colors active:bg-bg-sunk ${on ? "font-semibold text-accent" : "text-ink"}`}
              >
                {o.label}
                {on ? <IconCheck size={19} strokeWidth={2.2} /> : <span className="text-[12.5px] text-ink-4">{o.order}</span>}
              </button>
            );
          })}
        </div>
        <h3 className="px-5 pb-2 pt-5 text-[12.5px] font-medium text-ink-4">筛选</h3>
        <div role="group" aria-label="筛选模型（可多选）" className="mx-4 divide-y divide-line-soft overflow-hidden rounded-card ring-1 ring-inset ring-line">
          {[
            { label: "国产模型", on: domestic, toggle: () => setDomestic((v) => !v) },
            { label: "开源模型", on: openWeights, toggle: () => setOpenWeights((v) => !v) },
          ].map((f) => (
            <button
              key={f.label}
              type="button"
              role="checkbox"
              aria-checked={f.on}
              onClick={f.toggle}
              className={`flex h-12 w-full items-center justify-between px-4 text-left text-[16px] transition-colors active:bg-bg-sunk ${f.on ? "font-semibold text-accent" : "text-ink"}`}
            >
              {f.label}
              <span aria-hidden="true" className={`inline-flex size-[22px] items-center justify-center rounded-full border transition-colors ${f.on ? "border-accent bg-accent text-accent-contrast" : "border-line-strong"}`}>
                {f.on && <IconCheck size={13} strokeWidth={3} />}
              </span>
            </button>
          ))}
        </div>
      </Sheet>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <section className="card p-5">
          <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
            <IconInfo size={16} className="text-accent" />
            如何看这张榜
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{board.howToRead}价格不参与排序，缺测不补分。能力表现请结合分项原始成绩与运行配置判断。</p>
          <Link viewTransition to="/leaderboard/rules" className="mt-2.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:text-accent-ink">
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
