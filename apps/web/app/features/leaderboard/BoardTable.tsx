import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import type { LbBoardEntry } from "@aihot/contracts/leaderboard";
import { SITE } from "@aihot/industry/site";
import { BrandMark } from "./BrandMark";
import { modelHref, noOfficialApi, score, yuan } from "./format";
import { monthDay } from "../../lib/format";
import { IconChevronDown } from "../../components/icons";

export type SortKey = "rank" | "released" | "coverage" | "cached" | "input" | "output";

/** The orders on offer, as the phone's sort sheet lists them (each in its natural direction). */
export const SORTS: Array<{ key: SortKey; label: string; order: string }> = [
  { key: "rank", label: `${SITE.name} 评分`, order: "分数高的在前" },
  { key: "released", label: "上线日期", order: "新的在前" },
  { key: "coverage", label: "证据覆盖", order: "覆盖多的在前" },
  { key: "input", label: "输入价格", order: "便宜的在前" },
  { key: "output", label: "输出价格", order: "便宜的在前" },
  { key: "cached", label: "缓存价格", order: "便宜的在前" },
];

function sortValue(e: LbBoardEntry, key: SortKey): number | null {
  switch (key) {
    case "rank":
      return e.rank;
    case "released":
      return e.model.releasedAt ? -Date.parse(e.model.releasedAt) : null;
    case "coverage":
      return -(e.coverage * 1000 + e.sourceCount);
    case "cached":
      return e.price?.cachedCny ?? null;
    case "input":
      return e.price?.inputCny ?? null;
    case "output":
      return e.price?.outputCny ?? null;
  }
}

function sorted(entries: LbBoardEntry[], key: SortKey, dir: 1 | -1) {
  return [...entries].sort((a, b) => {
    const va = sortValue(a, key);
    const vb = sortValue(b, key);
    if (va === null && vb === null) return a.rank - b.rank;
    if (va === null) return 1; // unknown prices and dates always sink
    if (vb === null) return -1;
    return (va - vb) * dir || a.rank - b.rank;
  });
}

/** A reference position is shown without a podium or winner treatment. */
function Rank({ rank }: { rank: number }) {
  return <span className="mono text-[13px] text-ink-4">{String(rank).padStart(2, "0")}</span>;
}

function SortHeader({ k, children, sort, dir, onSort, align = "left", className = "" }: { k: SortKey; children: ReactNode; sort: SortKey; dir: 1 | -1; onSort: (k: SortKey) => void; align?: "left" | "right"; className?: string }) {
  const active = sort === k;
  return (
    <th scope="col" aria-sort={active ? (dir === 1 ? "ascending" : "descending") : "none"} className={`px-3 py-2.5 font-medium ${align === "right" ? "text-right" : "text-left"} ${className}`}>
      <button type="button" onClick={() => onSort(k)} className={`group/sort inline-flex items-start gap-1 text-left transition-colors hover:text-ink ${active ? "text-accent" : ""}`}>
        <span>{children}</span>
        <span className={`mt-[3px] text-[9px] transition ${active ? "opacity-100" : "opacity-0 group-hover/sort:opacity-40"} ${active && dir === -1 ? "rotate-180" : ""}`} aria-hidden="true">
          ▲
        </span>
      </button>
    </th>
  );
}

const unit = <span className="block text-[10.5px] font-normal text-ink-4">人民币 / 百万 Token</span>;

/** "9月3日" for a release date given as YYYY-MM-DD. */
function shortDate(date: string | null): string {
  return date ? monthDay(date) : "—";
}

/**
 * The board. Desktop: a table whose column heads sort it. Phones: a compact row per model (its maker and
 * release in one line) whose right column shows the score and supporting evidence, or the value the board is
 * sorted by; the order is chosen in a sheet the right column's head opens (`onSortSheet`).
 */
export function BoardTable({ entries, board, sort, dir, onSort, onSortSheet }: {
  entries: LbBoardEntry[];
  board: string;
  sort: SortKey;
  dir: 1 | -1;
  onSort: (key: SortKey, dir: 1 | -1) => void;
  onSortSheet: () => void;
}) {
  const navigate = useNavigate();
  const rows = useMemo(() => sorted(entries, sort, dir), [entries, sort, dir]);
  // Re-sorting moves each row from where it was to its new place (FLIP), as rows keep their key.
  const body = useRef<HTMLTableSectionElement>(null);
  const tops = useRef(new Map<string, number>());
  const order = rows.map((e) => e.model.slug).join(",");
  useLayoutEffect(() => {
    if (!body.current) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // Animate sorting the same models. A filtered subset may move rows several screens upward.
    const sameModels = tops.current.size === rows.length && rows.every((e) => tops.current.has(e.model.slug));
    const next = new Map<string, number>();
    for (const row of Array.from(body.current.rows)) {
      const key = row.dataset.slug ?? "";
      const prev = tops.current.get(key);
      next.set(key, row.offsetTop);
      if (sameModels && prev !== undefined && prev !== row.offsetTop && !reduce && row.animate) {
        row.animate([{ transform: `translateY(${prev - row.offsetTop}px)` }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(0.25, 1, 0.5, 1)" });
      }
    }
    tops.current = next;
  }, [order]);
  const sortBy = (k: SortKey) => onSort(k, k === sort ? (dir === 1 ? -1 : 1) : 1);
  // Not yet checked reads "待核验"; checked with no paid API reads "无官方价"; a missing tier (no cache pricing) reads "—".
  const price = (e: LbBoardEntry, v: number | null | undefined) =>
    !e.price ? <span className="text-[12px] text-ink-4">待核验</span>
    : noOfficialApi(e.price) ? <span className="text-[12px] text-ink-4" title={e.price.note ?? undefined}>无官方价</span>
    : v == null ? <span className="text-ink-4">—</span> : yuan(v);

  // Fixed column widths: filtering swaps the rows, and content-sized columns would jump (on phones the
  // name column takes what the rank and value columns leave, and long names end in an ellipsis).
  return (
    <table className="w-full table-fixed border-collapse text-[14px]">
      <caption className="sr-only">当前展示 {entries.length} 个模型，可按列重排；参考位次来自原榜</caption>
      <thead className="bg-[rgba(28,39,51,0.04)] text-[12px] text-ink-4 dark:bg-white/[0.03]">
        <tr className="border-y border-line">
          <th scope="col" className="w-[60px] py-2.5 pl-4 pr-1 text-left font-medium lg:w-[86px] lg:pl-[22px] lg:pr-3">
            {/* Phones order the board from the sheet only; a tap here would quietly turn it upside down. */}
            <span className="lg:hidden">参考<br />位次</span>
            <button type="button" onClick={() => sortBy("rank")} className={`hidden transition-colors hover:text-ink lg:inline ${sort === "rank" ? "text-accent" : ""}`}>
              参考位次
            </button>
          </th>
          <th scope="col" className="px-2 py-2.5 text-left font-medium lg:px-3">模型</th>
          <SortHeader k="released" sort={sort} dir={dir} onSort={sortBy} className="hidden lg:table-cell lg:w-[9%]">上线日期</SortHeader>
          <SortHeader k="coverage" sort={sort} dir={dir} onSort={sortBy} className="hidden lg:table-cell lg:w-[9%]">评测证据</SortHeader>
          <SortHeader k="cached" sort={sort} dir={dir} onSort={sortBy} className="hidden lg:table-cell lg:w-[12%]">缓存价格{unit}</SortHeader>
          <SortHeader k="input" sort={sort} dir={dir} onSort={sortBy} className="hidden lg:table-cell lg:w-[12%]">输入价格{unit}</SortHeader>
          <SortHeader k="output" sort={sort} dir={dir} onSort={sortBy} className="hidden lg:table-cell lg:w-[12%]">输出价格{unit}</SortHeader>
          <th scope="col" className="w-[104px] py-1 pl-0 pr-2 text-right font-medium lg:w-[11%] lg:py-2.5 lg:pl-3 lg:pr-[22px]">
            {/* Phones: the order in use; tapping it opens the sort sheet. */}
            <button type="button" onClick={onSortSheet} aria-haspopup="dialog" className="inline-flex h-11 items-center gap-1 whitespace-nowrap rounded-full px-2 text-accent active:bg-bg-sunk lg:hidden">
              {SORTS.find((x) => x.key === sort)!.label}
              <IconChevronDown size={14} />
            </button>
            <button
              type="button"
              onClick={() => sortBy("rank")}
              title="0–100 的综合比较分数，越高表示本榜表现越强；不是正确率。同分仍按参考位次排列。"
              className={`hidden items-center gap-1 whitespace-nowrap transition-colors hover:text-ink lg:inline-flex ${sort === "rank" ? "text-accent" : ""}`}
            >
              {SITE.name} 评分 <span className="inline-flex size-3.5 items-center justify-center rounded-full border border-current text-[9px] leading-none">i</span>
            </button>
          </th>
        </tr>
      </thead>
      <tbody ref={body}>
        {rows.map((e) => (
          <tr
            key={e.model.slug}
            data-slug={e.model.slug}
            className="group cursor-pointer border-b border-line last:border-b-0 transition-colors hover:bg-accent-softer"
            onClick={(event) => {
              // Older WebKit cannot contain an absolute link overlay within a table row.
              // Delegate plain row clicks; real links and focusable controls keep their own behavior.
              if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              if (event.target instanceof Element && event.target.closest("a, button, input, select, textarea, [tabindex]")) return;
              if (window.getSelection()?.toString()) return;
              navigate(modelHref(e.model.slug, board), { viewTransition: true });
            }}
          >
            <td className="py-2.5 pl-4 pr-1 align-middle lg:py-3 lg:pl-[22px] lg:pr-3">
              <Rank rank={e.rank} />
            </td>
            <td className="px-2 py-2.5 lg:px-3 lg:py-3">
              <span className="flex items-center gap-3">
                <BrandMark brand={e.model.brand} size={32} />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <Link viewTransition to={modelHref(e.model.slug, board)} prefetch="intent">
                      <strong className="text-[15px] font-[650] leading-[21px] text-ink transition-colors group-hover:text-accent">{e.model.name}</strong>
                    </Link>
                    {e.access?.weightsUrl && (
                      <a href={e.access.weightsUrl} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap text-[11px] text-accent hover:underline" aria-label={`${e.model.name} 开源权重`}>
                        开源权重 ↗
                      </a>
                    )}
                  </span>
                  <small className="hidden text-[12px] leading-[18px] text-ink-4 lg:block">{e.model.provider ?? "—"}</small>
                  {/* Phones: maker and release in one line under the name. */}
                  <small className="block truncate text-[12px] leading-[18px] text-ink-4 lg:hidden">
                    {e.model.provider ?? "—"} · <span className="num">{shortDate(e.model.releasedAt)}</span>上线
                  </small>
                </span>
              </span>
            </td>
            <td className="mono hidden px-3 py-3 text-[12px] text-ink-3 lg:table-cell">
              <time dateTime={e.model.releasedAt ?? undefined}>{e.model.releasedAt ?? "—"}</time>
            </td>
            <td className="hidden px-3 py-3 lg:table-cell">
              <span className="num block text-[13px] text-ink-2">{e.sourceCount} 项评测</span>
              <span className="block text-[11px] leading-[17px] text-ink-4">覆盖 {Math.round(e.coverage * 100)}%</span>
            </td>
            <td className="mono hidden px-3 py-3 text-[14.5px] font-medium text-ink lg:table-cell">{price(e, e.price?.cachedCny)}</td>
            <td className="mono hidden px-3 py-3 text-[14.5px] font-medium text-ink lg:table-cell">{price(e, e.price?.inputCny)}</td>
            <td className="mono hidden px-3 py-3 text-[14.5px] font-medium text-ink lg:table-cell">{price(e, e.price?.outputCny)}</td>
            <td className="py-2.5 pl-2 pr-4 text-right align-middle lg:py-3 lg:pl-3 lg:pr-[22px]">
              <span className={sort === "rank" ? "block" : "hidden lg:block"}>
                <strong className="mono block text-[24px] font-semibold leading-7 tracking-[-0.025em] text-accent lg:text-[22px]" aria-label={`${e.model.name} ${SITE.name} 评分 ${score(e.score)}`}>
                  {score(e.score)}
                </strong>
                <small className="block text-[11px] leading-[17px] text-ink-4 lg:hidden">覆盖 {Math.round(e.coverage * 100)}%</small>
              </span>
              {sort !== "rank" && (
                <span className="block lg:hidden">
                  <span className="mono text-[15px] font-semibold text-ink">
                    {sort === "coverage" ? `${Math.round(e.coverage * 100)}%` : sort === "released" ? shortDate(e.model.releasedAt) : price(e, sort === "input" ? e.price?.inputCny : sort === "output" ? e.price?.outputCny : e.price?.cachedCny)}
                  </span>
                  <small className="block text-[11px] leading-[17px] text-ink-4">评分 {score(e.score)}</small>
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
