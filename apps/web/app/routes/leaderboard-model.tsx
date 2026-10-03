import { useEffect, useState, type ReactNode } from "react";
import { Link, useLoaderData, useSearchParams } from "react-router";
import { Collapse } from "../components/ui/Presence";
import type { Route } from "./+types/leaderboard-model";
import type { LbComparison, LbEvidenceItem, LbModelDetail } from "@aihot/contracts/leaderboard";
import { LEADERBOARD_BOARD_LABELS, LEADERBOARD_PUBLIC_BOARDS } from "@aihot/contracts/taxonomy";
import { beijingDate } from "@aihot/contracts/time";
import { SITE } from "@aihot/industry/site";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { monthDay } from "../lib/format";
import { breadcrumbLd, pageMeta, siteUrl, titled } from "../lib/seo";
import { BrandMark } from "../features/leaderboard/BrandMark";
import { boardHref, listPrice, noOfficialApi, pctFixed, score, shortStamp, tokensWan, yuan } from "../features/leaderboard/format";
import { IconArrowLeft, IconArrowRight, IconArrowUpRight, IconChevronDown, IconExternal } from "../components/icons";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "leaderboard" };

export async function loader({ params, request }: Route.LoaderArgs) {
  return loadOr404<LbModelDetail>(`/api/site/leaderboard/models/${encodeURIComponent(params.slug)}`, { signal: request.signal });
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("页面不存在") }];
  const { model } = loaderData;
  const path = `/leaderboard/${model.slug}`;
  return pageMeta({
    title: `${model.name} 评分、排名与各项成绩`,
    description: `查看 ${model.name} 的${loaderData.historical ? "历史" : "当前"} ${SITE.name} 评分、参考位次与证据覆盖，以及各项公开评测的原始成绩和运行配置。`,
    path,
    image: "/og/pages/leaderboard.png",
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "Dataset",
        name: `${model.name} 在 ${SITE.name} 模型榜的成绩`,
        description: `${model.name} 的 ${SITE.name} 评分、参考位次与各项公开评测的原始成绩。`,
        url: `${siteUrl()}${path}`,
        creator: { "@type": "Organization", name: SITE.name, url: siteUrl() },
        isAccessibleForFree: true,
      },
      breadcrumbLd([
        { name: "模型榜", path: "/leaderboard" },
        { name: model.name, path },
      ]),
    ],
  });
}

export function headers() {
  return edgeTtl(600);
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="mono text-[11px] font-semibold tracking-[0.14em] text-accent">{children}</span>;
}

function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return (
    <>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="mt-2 text-[20px] font-bold leading-[1.5] text-ink">{title}</h2>
      <p className="mt-1 text-[13px] text-ink-3">{sub}</p>
    </>
  );
}

function Stat({ label, children, foot }: { label: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-[11px] text-ink-4">{label}</span>
      <span className="mono mt-2 text-[20px] font-semibold leading-tight text-ink">{children}</span>
      {foot && <span className="mt-1.5 text-[12px] text-ink-3">{foot}</span>}
    </div>
  );
}

function Capability({ d, from }: { d: LbModelDetail; from: string }) {
  return (
    <section className="mt-12">
      <SectionHead eyebrow="CAPABILITY PROFILE" title="各有所长，看得更清楚。" sub="每类单独评分，越高表示该分类表现越强。具体能力请看原始成绩与配置。" />
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {d.categories.map((c) => (
          <Link
            key={c.key}
            to={boardHref(c.key)}
            className={`card card-hover group flex h-full flex-col rounded-card p-4 lg:p-[22px] ${c.key === from ? "border-accent/45" : ""}`}
          >
            <span className="text-[14px] font-semibold text-ink transition-colors group-hover:text-accent">{c.name}</span>
            <span className="mt-3 text-[11px] text-ink-4">{SITE.name} 评分</span>
            <span className="mono mt-1 text-[28px] font-medium leading-tight tracking-[-0.03em] text-ink">{score(c.score)}<span className="ml-1 text-[12px] text-ink-4">分</span></span>
            {c.rank !== null && <span className="mt-1 text-[12px] text-ink-3">参考第 {c.rank} 位</span>}
            {!c.onBoard && <span className="mt-1 text-[11px] text-ink-4">{c.rank === null ? "暂无足够的可比成绩" : "前 30 位之外"}</span>}
            <span className="mt-auto pt-4 text-[12px] text-ink-3">{c.sourceCount} 项评测 · 覆盖 {Math.round(c.coverage * 100)}%</span>
          </Link>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-ink-4">评分和参考位次只在同一分类、同一轮内比较。缺测不补分；覆盖比例不代表能力高低。</p>
    </section>
  );
}

/** A continuous relative difference on shared evaluations; not a win probability. */
function NetValue({ net }: { net: number }) {
  const v = Math.round(net * 100) / 100;
  if (v === 0) return <span className="text-[12px] text-ink-4">0.00</span>;
  return <span className={`mono text-[12.5px] font-semibold ${v > 0 ? "text-accent" : "text-amber-ink"}`}>{v > 0 ? `+${v.toFixed(2)}` : `−${Math.abs(v).toFixed(2)}`}</span>;
}

function Comparisons({ d }: { d: LbModelDetail }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-line">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center justify-between py-4 text-left">
        <span className="text-[13.5px] font-semibold text-ink">查看与附近模型的共同证据</span>
        <span className={`text-[18px] leading-none text-ink-4 transition-transform duration-300 ${open ? "rotate-45" : ""}`}>
          +
        </span>
      </button>
      <Collapse open={open} duration={300}>
        <p className="text-[13px] text-ink-3">共同评测的相对成绩差只看双方都有成绩的项目。正值表示本模型较高，负值表示对方较高；不是胜率，也不表示显著领先。完整参考顺序还需处理其他模型间的冲突。</p>
        <ul className="-mx-3 divide-y divide-line-soft pb-3 pt-2">
          {d.comparisons.map((c) => <ComparisonRow key={c.model.slug} c={c} name={d.model.name} />)}
        </ul>
      </Collapse>
    </div>
  );
}

function ComparisonRow({ c, name }: { c: LbComparison; name: string }) {
  const [open, setOpen] = useState(false);
  const favours = c.net > 1e-9 ? "本模型相对成绩较高" : c.net < -1e-9 ? "对方相对成绩较高" : "相对成绩差为零";
  return (
    <li>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-3 rounded-tile px-3 py-3 text-left transition-colors hover:bg-bg-sunk">
        <BrandMark brand={c.model.brand} size={26} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-ink">{c.model.name} <span className="num text-[12px] text-ink-4">参考 {c.rank} 位</span></span>
          <span className="text-[12px] text-ink-3">{c.sharedCount} 项共同评测 · {favours}</span>
        </span>
        <NetValue net={c.net} />
        <span className={`text-ink-4 transition-transform duration-300 ${open ? "rotate-180" : ""}`}><IconChevronDown size={15} /></span>
      </button>
      <Collapse open={open} duration={300}>
        <div className="px-3 pb-4">
          <p className="text-[12.5px] leading-relaxed text-ink-3">
            共同评测的权重合计为 {pctFixed(c.sharedWeight)}。相对成绩差采用固定参照校准后的连续分差，缺测项目不参与。下表保留采用的原始成绩。
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[420px] text-[12.5px]">
              <thead className="text-ink-4">
                <tr className="border-b border-line">
                  <th className="py-2 text-left font-medium">共同评测</th>
                  <th className="py-2 text-right font-medium">{name}</th>
                  <th className="py-2 text-right font-medium">{c.model.name}</th>
                  <th className="py-2 text-right font-medium">权重</th>
                </tr>
              </thead>
              <tbody>
                {c.rows.map((r) => (
                  <tr key={r.sourceKey} className="border-b border-line last:border-0">
                    <td className="py-2 pr-2"><Link viewTransition to={`/leaderboard/sources/${r.sourceKey}`} className="text-ink-2 hover:text-accent">{r.sourceName}</Link></td>
                    <td className="num py-2 text-right text-ink">{r.mine}</td>
                    <td className="num py-2 text-right text-ink-2">{r.theirs}</td>
                    <td className="num py-2 text-right text-ink-4">{pctFixed(r.weight)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {c.hasPage && (
            <Link viewTransition to={`/leaderboard/${c.model.slug}`} className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent">
              查看 {c.model.name} 的完整证据 <IconArrowRight size={13} />
            </Link>
          )}
        </div>
      </Collapse>
    </li>
  );
}

function EvidenceCard({ it }: { it: LbEvidenceItem }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="card overflow-hidden rounded-tile">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors hover:bg-accent-softer lg:px-5">
        <BrandMark brand={it.brand} size={28} className="max-sm:hidden" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-semibold text-ink">{it.sourceName}</span>
          <small className="text-[11px] text-ink-4">{it.usage}</small>
        </span>
        <span className="text-right">
          <span className="mono block text-[19px] font-medium leading-tight text-ink">{it.display}</span>
          {it.displayNote && <span className="block text-[11px] text-ink-4">{it.displayNote}</span>}
        </span>
        <span className={`grid size-6 shrink-0 place-items-center text-[17px] leading-none text-ink-4 transition-transform duration-300 ${open ? "rotate-45" : ""}`}>
          +
        </span>
      </button>
      <Collapse open={open} duration={300}>
        <dl className="grid gap-3 border-t border-line-soft px-4 py-4 text-[12.5px] sm:grid-cols-2 lg:px-5">
          <div>
            <dt className="text-ink-4">原榜型号</dt>
            <dd className="mt-0.5 break-all font-mono text-[12px] text-ink-2">{it.sourceModelName ?? "—"}{it.sourceRank !== null && <span className="ml-1.5 font-sans text-ink-4">原榜第 {it.sourceRank} 名</span>}</dd>
          </div>
          <div>
            <dt className="text-ink-4">代表配置</dt>
            <dd className="mt-0.5 text-ink-2">{it.configurationLabel ?? "—"}</dd>
          </div>
          {it.selectionReason && <p className="text-ink-3 sm:col-span-2">{it.selectionReason}</p>}
          <div className="sm:col-span-2">
            <dt className="text-ink-4">本轮采用记录</dt>
            <dd className="num mt-0.5 text-ink-2">
              来源数据 {shortStamp(it.upstreamAt)} · 核验 {shortStamp(it.verifiedAt)} · {it.measuredAt ? `实测 ${shortStamp(it.measuredAt)}` : "实测日期未公开"}
              {it.carriedForward && " · 沿用最近一次已核验记录"}
            </dd>
          </div>
          {it.components.length > 0 && (
            <div className="sm:col-span-2">
              {it.componentsNote && <p className="text-ink-3">{it.componentsNote}</p>}
              <div className="mt-2 flex gap-2">
                {it.components.map((c) => (
                  <span key={c.label} className="rounded-control bg-bg-sunk px-3 py-1.5">
                    <span className="block text-[11px] text-ink-4">{c.label}</span>
                    <span className="num text-[14px] font-semibold text-ink">{c.display}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-4 sm:col-span-2">
            <Link viewTransition to={`/leaderboard/sources/${it.sourceKey}`} className="inline-flex items-center gap-1 font-medium text-accent">查看这项评测 <IconArrowRight size={13} /></Link>
            {it.officialUrl && (
              <a href={it.officialUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink-3 hover:text-accent">官方来源 <IconExternal size={12} /></a>
            )}
          </div>
        </dl>
      </Collapse>
    </li>
  );
}

export default function LeaderboardModelPage() {
  const d = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  // The server page is shared by every ?from= (shared caches keep it once), so the board to return
  // to is applied after hydration; server HTML and the first client render both say "总榜".
  const [fromParam, setFromParam] = useState<string | null>(null);
  useEffect(() => setFromParam(params.get("from")), [params]);
  const from = fromParam && (LEADERBOARD_PUBLIC_BOARDS as readonly string[]).includes(fromParam) ? fromParam : "overall";
  const { model, price, overall } = d;
  const withRanks = d.categories.filter((c) => c.rank !== null).length;
  return (
    <div className="pb-12">
      <PhoneBar back={{ to: boardHref(from), label: "模型榜" }} title={model.name} />
      <Link to={boardHref(from)} className="hidden items-center gap-1.5 py-2 text-[13px] text-ink-3 transition-colors hover:text-accent lg:inline-flex">
        <IconArrowLeft size={14} /> 返回{LEADERBOARD_BOARD_LABELS[from as keyof typeof LEADERBOARD_BOARD_LABELS]}榜
      </Link>

      {d.historical && (
        <p className="well mt-4 px-4 py-3 text-[13px] leading-relaxed text-ink-3">
          该模型当前未入榜。以下保留它最后一次已发布的成绩，参考顺序与评测证据截至 {monthDay(beijingDate(d.run.generatedAt))}。
        </p>
      )}

      <header className="mt-3 flex flex-col gap-5 pb-7 sm:flex-row sm:items-end sm:justify-between lg:mt-5">
        <div className="flex items-center gap-4">
          <BrandMark brand={model.brand} size={52} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] tracking-[-0.02em] text-ink">{model.name}</h1>
              {model.weightsUrl && (
                <a href={model.weightsUrl} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap text-[12.5px] text-accent hover:underline">
                  开源权重 ↗
                </a>
              )}
            </div>
            <p className="num mt-1 text-[12.5px] text-ink-3">
              {model.provider ?? "—"} · {model.releasedAt ? `${model.releasedAt} 发布` : "发布日期待核实"} · {shortStamp(d.run.generatedAt)} 更新
            </p>
          </div>
        </div>
        <div className="sm:text-right">
          <span className="block text-[12px] text-ink-4">{SITE.name} 评分 · 综合</span>
          <strong className="mono block text-[38px] font-medium leading-[1.4] tracking-[-0.035em] text-accent lg:text-[44px]">{score(overall.score)}<span className="ml-1 text-[14px] font-normal text-ink-4">分</span></strong>
          {overall.rank !== null && <span className="block text-[13px] text-ink-2">综合参考位次 · 第 {overall.rank} 位</span>}
          <span className="block text-[12px] text-ink-3">
            {overall.rank === null ? "暂无足够的可比证据" : overall.score === null ? "该历史轮次未提供此评分" : "0–100 分，非正确率"} · 证据覆盖 {Math.round(overall.coverage * 100)}%
          </span>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-x-4 gap-y-6 border-y border-line py-6 lg:grid-cols-4" aria-label="模型概览">
        <Stat label="可比较分类">
          {withRanks}
          <small className="ml-1 font-sans text-[11px] font-normal text-ink-4">/ 4 项分类</small>
        </Stat>
        <Stat label="已有成绩">
          {d.metricCount}
          <small className="ml-1 font-sans text-[11px] font-normal text-ink-4">项评测</small>
        </Stat>
        <Stat label="上下文窗口">
          {tokensWan(model.contextWindowTokens)}
          <small className="ml-1 font-sans text-[11px] font-normal text-ink-4">Token</small>
        </Stat>
        <Stat
          label="API 输入 / 输出 · 每百万 Token"
          foot={
            price ? (
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                {noOfficialApi(price) && <span>{price.note ?? "厂商未提供付费 API"}</span>}
                {price.cachedCny !== null && <span className="num">缓存 {yuan(price.cachedCny)}</span>}
                {price.currency === "USD" && !noOfficialApi(price) && (
                  <span className="num text-ink-4">
                    原价 {listPrice(price.input, "USD")} / {listPrice(price.output, "USD")}
                  </span>
                )}
                {price.officialUrl && (
                  <a href={price.officialUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:text-accent-ink">
                    {noOfficialApi(price) ? "来源" : "厂商官方价格"} <IconArrowUpRight size={12} />
                  </a>
                )}
              </span>
            ) : (
              "尚未核到厂商官网价格"
            )
          }
        >
          {price && !noOfficialApi(price) ? `${yuan(price.inputCny)} / ${yuan(price.outputCny)}` : <span className="font-sans text-[15px] font-normal text-ink-4">{price ? "无官方价" : "待核验"}</span>}
        </Stat>
      </section>

      <Capability d={d} from={from} />
      {d.comparisons.length > 0 && <section className="mt-12"><Comparisons d={d} /></section>}

      <section className="mt-12">
        <SectionHead eyebrow="BEHIND THE SCORE" title="每一项成绩，都有来处。" sub="下面是该模型的公开汇总成绩。展开可查看运行配置与采用方式。" />
        {d.evidence.map((g) => (
          <div key={g.key} className="mt-6">
            <h3 className="flex items-baseline gap-2 text-[14px] font-semibold text-ink">
              {g.name}
              <span className="num text-[11.5px] font-normal text-ink-4">{g.items.length} 项</span>
            </h3>
            <ul className="mt-2.5 space-y-2">
              {g.items.map((it) => (
                <EvidenceCard key={it.sourceKey} it={it} />
              ))}
            </ul>
          </div>
        ))}
        {d.excluded.length > 0 && (
          <div className="mt-6">
            <h3 className="text-[14px] font-semibold text-ink">测过，但按规则不计入</h3>
            <p className="mt-1 text-[12.5px] text-ink-3">这些公开成绩未满足本榜的可比条件，具体原因如下。统一固定工具、全程使用同一型号可以采用；多模型回退、混合模型与专属异构 Agent 系统不混入模型榜。资料未说明的项目保留未知。</p>
            <ul className="mt-2.5 space-y-1.5 text-[13px]">
              {d.excluded.map((x) => (
                <li key={x.key}>
                  <Link viewTransition to={`/leaderboard/sources/${x.key}`} className="font-medium text-ink-2 transition-colors hover:text-accent">{x.name}</Link>
                  <span className="text-ink-3">：{x.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {d.unmeasured.length > 0 && (
          <div className="mt-6">
            <h3 className="text-[14px] font-semibold text-ink">尚无成绩的评测</h3>
            <p className="mt-1 text-[12.5px] text-ink-3">这些评测尚无可采用的公开成绩，缺测不补分。</p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {d.unmeasured.map((u) => (
                <Link viewTransition key={u.key} to={`/leaderboard/sources/${u.key}`} className="chip">
                  {u.name}
                </Link>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="mt-10 border-t border-line pt-6">
        <h2 className="text-[15px] font-semibold text-ink">还有一些未知</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">参考顺序只概括已取得的公开证据，缺测不补分。不同运行配置、未知误差与新评测都可能改变顺序，相邻位次不等于已证明的能力差距。</p>
        {overall.missingDimensions.length > 0 && <p className="mt-1.5 text-[13px] text-ink-3">尚缺能力维度：{overall.missingDimensions.join("、")}。</p>}
        {overall.unknownErrorCount > 0 && <p className="mt-1.5 text-[13px] text-ink-3">{overall.unknownErrorCount} 项采用的成绩未公开可用标准误；未知不按零误差处理。</p>}
        <Link viewTransition to="/leaderboard/rules" className="mt-2.5 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:text-accent-ink">
          了解计算方法 →
        </Link>
      </section>
    </div>
  );
}
