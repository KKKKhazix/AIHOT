import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/leaderboard-source";
import type { LbSourceDetail } from "@aihot/contracts/leaderboard";
import { SITE } from "@aihot/industry/site";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta, siteUrl, titled } from "../lib/seo";
import { BrandMark } from "../features/leaderboard/BrandMark";
import { StatusChip } from "../features/leaderboard/StatusChip";
import { pct, shortStamp } from "../features/leaderboard/format";
import { IconArrowLeft, IconArrowUpRight, IconChevronDown } from "../components/icons";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "leaderboard" };

export async function loader({ params, request }: Route.LoaderArgs) {
  return loadOr404<LbSourceDetail>(`/api/site/leaderboard/sources/${encodeURIComponent(params.key)}`, { signal: request.signal });
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("页面不存在") }];
  const { source } = loaderData;
  const path = `/leaderboard/sources/${source.key}`;
  return pageMeta({
    title: `${source.name} · 评测来源`,
    description: source.description,
    path,
    image: "/og/pages/leaderboard.png",
    jsonLd: [
      {
        "@context": "https://schema.org",
        "@type": "Dataset",
        name: source.fullName,
        description: source.description,
        url: `${siteUrl()}${path}`,
        creator: { "@type": "Organization", name: source.operator },
        ...(source.officialUrl ? { sameAs: source.officialUrl } : {}),
      },
      breadcrumbLd([
        { name: "模型榜", path: "/leaderboard" },
        { name: "评测来源", path: "/leaderboard/sources" },
        { name: source.name, path },
      ]),
    ],
  });
}

export function headers() {
  return edgeTtl(300);
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <span className="text-[11px] text-ink-4">{label}</span>
      <span className="mono mt-2 block text-[16px] font-semibold text-ink">{children}</span>
    </div>
  );
}

export default function LeaderboardSourcePage() {
  const d = useLoaderData<typeof loader>();
  const { source } = d;
  return (
    <div className="pb-12">
      <PhoneBar back={{ to: "/leaderboard/sources", label: "评测来源" }} title={source.fullName} />
      <Link to="/leaderboard/sources" className="hidden items-center gap-1.5 py-2 text-[13px] text-ink-3 transition-colors hover:text-accent lg:inline-flex">
        <IconArrowLeft size={14} /> 评测来源
      </Link>

      <header className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between lg:mt-4">
        <div className="flex gap-4">
          <BrandMark brand={source.brand} size={44} />
          <div className="min-w-0">
            <h1 data-page-title="" className="text-[22px] font-semibold leading-[1.35] text-ink">{source.fullName}</h1>
            <p className="mt-1 text-[13px] leading-relaxed text-ink-3">
              {source.operator}
              {source.area ? ` / ${source.area}` : ""} · {source.description}
            </p>
          </div>
        </div>
        {source.officialUrl && (
          <a
            href={source.officialUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 shrink-0 items-center gap-1.5 self-start rounded-full border border-line-strong bg-surface px-3 text-[12.5px] text-ink-2 transition-colors hover:border-ink-4 hover:text-ink"
          >
            官方评测 <IconArrowUpRight size={13} />
          </a>
        )}
      </header>

      <section className="mt-6 grid grid-cols-2 gap-x-4 gap-y-5 border-y border-line py-5 lg:grid-cols-4" aria-label={`在 ${SITE.name} 中`}>
        <div className="min-w-0">
          <span className="text-[11px] text-ink-4">在 {SITE.name} 中</span>
          <span className="mt-1.5 block">
            <StatusChip status={source.status} large />
          </span>
        </div>
        <Stat label="证据预算">{source.budget !== null ? pct(source.budget) : <span className="font-sans text-[14px] font-normal text-ink-3">不参与排序</span>}</Stat>
        <Stat label="上游数据时间">{d.collected ? shortStamp(d.upstreamAt) : <span className="font-sans text-[14px] font-normal text-ink-3">待核实</span>}</Stat>
        <Stat label="最近成功同步">
          {d.collected ? shortStamp(d.syncedAt) : <span className="font-sans text-[14px] font-normal text-ink-3">{source.status === "awaiting" ? "等待可比成绩" : "尚未开始采集"}</span>}
        </Stat>
      </section>

      <section className="mt-6 grid gap-6 md:grid-cols-2 md:gap-10">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">它测什么，怎么测</h2>
          <p className="mt-2 text-[13px] leading-[1.8] text-ink-3">{source.what}</p>
        </div>
        <div>
          <h2 className="text-[14px] font-semibold text-ink">如何使用这份证据</h2>
          <p className="mt-2 text-[13px] leading-[1.8] text-ink-3">{source.usage}</p>
        </div>
      </section>

      {d.collected && d.rows.length > 0 && (
        <section className="mt-10">
          <h2 className="text-[18px] font-bold text-ink">评测成绩</h2>
          {d.rowsNote && <p className="mt-1 text-[12.5px] text-ink-3">{d.rowsNote}</p>}
          <div className="card mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] text-[13.5px]">
              <thead className="bg-[rgba(28,39,51,0.04)] text-[12px] text-ink-4 dark:bg-white/[0.03]">
                <tr className="border-b border-line">
                  <th scope="col" className="w-24 whitespace-nowrap px-4 py-2.5 text-left font-medium lg:px-[22px]">原榜名次</th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">原榜型号</th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">原始成绩</th>
                  <th scope="col" className="px-4 py-2.5 text-left font-medium lg:px-[22px]">{d.systemRows ? "运行配置" : "代表配置"}</th>
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r, i) => (
                  <tr key={`${r.sourceModelName}-${i}`} className="border-b border-line last:border-0 transition-colors hover:bg-accent-softer">
                    <td className="mono px-4 py-3.5 text-[13px] text-ink-4 lg:px-[22px]">{r.sourceRank ?? "—"}</td>
                    <td className="px-3 py-3.5">
                      {r.modelSlug ? (
                        <Link viewTransition to={`/leaderboard/${r.modelSlug}`} className="mono break-all text-[12.5px] font-semibold text-ink transition-colors hover:text-accent">
                          {r.sourceModelName}
                        </Link>
                      ) : (
                        <span className="mono break-all text-[12.5px] font-semibold text-ink-2">{r.sourceModelName}</span>
                      )}
                      <span className="block text-[11.5px] text-ink-4">{r.provider ?? "—"}</span>
                    </td>
                    <td className="mono px-3 py-3.5 text-[15px] font-medium text-ink">{r.display}</td>
                    <td className="px-4 py-3.5 text-[12.5px] text-ink-3 lg:px-[22px]">
                      {r.configurationLabel ?? "—"}
                      {r.excluded && <span className="mt-0.5 block text-[11.5px] text-amber-ink">未计入：{r.excluded}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <details className="disclosure group mt-6 border-y border-line">
        <summary className="flex items-center justify-between py-4 text-[14px] font-semibold text-ink">
          评测局限与数据署名
          <IconChevronDown size={16} className="text-ink-4 transition-transform duration-200 group-open:rotate-180" />
        </summary>
        <div className="space-y-2 pb-5 text-[13px] leading-relaxed text-ink-3">
          <p>{source.limits}</p>
          <p>
            <span className="text-ink-4">数据许可：</span>
            {source.license}
          </p>
          <p className="text-ink-4">{source.attribution}</p>
        </div>
      </details>
    </div>
  );
}
