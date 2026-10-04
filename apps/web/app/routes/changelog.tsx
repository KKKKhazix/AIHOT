import { useEffect, useState, type ComponentType } from "react";
import { IntentLink } from "../components/ui/IntentLink";
import type { ChangelogRelease, ChangelogResponse } from "@aihot/contracts/site";
import { SITE } from "@aihot/site";
import { useLoaderData } from "react-router";
import { apiGet, edgeTtl, pageExpiresAt } from "../lib/api.server";
import { cachedLoader } from "../lib/page-reuse";
import { pageMeta } from "../lib/seo";
import { setChangelogSeen } from "../lib/local-state";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { IconChevronRight } from "../components/icons";
import { Inline, dateHeading } from "../features/changelog/text";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "me", name: "更新日志" };
export { shouldRevalidate } from "../lib/page-reuse";
export const clientLoader = cachedLoader<typeof loader>();

export function headers() {
  return edgeTtl(300);
}

type Release = ChangelogRelease;

export async function loader({ request }: { request: Request }) {
  return { ...await apiGet<ChangelogResponse>("/api/site/changelog", { signal: request.signal }), expiresAt: pageExpiresAt(300) };
}

export function meta() {
  return pageMeta({ title: "更新日志", description: `${SITE.name} 的功能更新、优化、公告与下线记录。`, path: "/changelog", image: "/og/pages/changelog.png" });
}

const KIND_DOT: Record<Release["kind"], string> = {
  更新: "bg-accent",
  优化: "bg-ok",
  公告: "bg-amber",
  下线: "bg-ink-4",
};

const KINDS = Object.keys(KIND_DOT) as Release["kind"][];

function ReleaseBody({ lines }: { lines: string[] }) {
  const blocks: Array<string | string[]> = [];
  for (const line of lines) {
    const last = blocks.at(-1);
    if (!line.startsWith("- ")) blocks.push(line);
    else if (Array.isArray(last)) last.push(line.slice(2));
    else blocks.push([line.slice(2)]);
  }
  const text = "mt-2 max-w-[52em] text-[13.5px] leading-[1.8] text-ink-3";
  return blocks.map((b, i) =>
    Array.isArray(b) ? (
      <ul key={i} className={`${text} space-y-1`}>
        {b.map((li, j) => (
          <li key={j} className="flex gap-2">
            <span className="mt-[11px] size-1 shrink-0 rounded-full bg-ink-4" aria-hidden="true" />
            <span>
              <Inline text={li} />
            </span>
          </li>
        ))}
      </ul>
    ) : (
      <p key={i} className={text}>
        <Inline text={b} />
      </p>
    ),
  );
}

/** One date's releases in a card; `id` is the jump target of the month index. */
function Day({ date, releases, id }: { date: string; releases: Release[]; id?: string }) {
  const h = dateHeading(date);
  return (
    <section id={id} className="card scroll-mt-[calc(var(--bar-h)+1.5rem)] px-5 lg:px-7">
      <h2 className="flex items-baseline gap-3 border-b border-line-soft py-4">
        <time dateTime={date} className="text-[18px] font-bold text-ink">
          {h.label}
        </time>
        <span className="text-[12px] text-ink-4">{h.weekday}</span>
      </h2>
      <ol>
        {releases.map((r) => (
          <li
            key={`${r.date}-${r.time}-${r.title}`}
            className={`grid gap-x-8 gap-y-2 border-b border-line-soft py-5 last:border-b-0 sm:grid-cols-[88px_minmax(0,1fr)] ${r.urgent ? "-mx-5 border-l-4 border-l-hot bg-hot-soft pl-4 pr-5 lg:-mx-7 lg:pl-6 lg:pr-7" : ""}`}
          >
            <div className="flex items-center gap-3 sm:block">
              <span className="mono block text-[12.5px] text-ink-3">{r.time}</span>
              <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-4 sm:mt-1.5">
                <span className={`size-1.5 rounded-full ${r.urgent ? "bg-hot" : KIND_DOT[r.kind]}`} aria-hidden="true" />
                {r.kind}
              </span>
            </div>
            <article className={`min-w-0 sm:border-l sm:pl-8 ${r.urgent ? "sm:border-hot/40" : "sm:border-line"}`}>
              {r.urgent && <span className="mb-2 inline-flex rounded-full bg-hot px-2.5 py-0.5 text-[12px] font-semibold text-white">重要</span>}
              <h3 className={`text-[15px] font-bold leading-snug ${r.urgent ? "text-hot" : "text-ink"}`}>{r.title}</h3>
              <ReleaseBody lines={r.body} />
            </article>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Draws a major release: its `feature`, whose shape is the site's. */
type FeatureDrawing = ComponentType<{ release: Release; id?: string }>;

/** The site's drawing (site/changelog/FeatureRelease.tsx), when it ships one. */
const SITE_FEATURE = Object.values(import.meta.glob<FeatureDrawing>("../../../../site/changelog/FeatureRelease.tsx", { eager: true, import: "FeatureRelease" }))[0];

/**
 * A date with a major release: each release's `feature` is drawn as its own block by the site's drawing,
 * the first one carrying the date's anchor, above a card of the date's other releases; `body` stays the
 * short form.
 */
function FeatureDay({ date, releases, Drawing }: { date: string; releases: Release[]; Drawing: FeatureDrawing }) {
  const features = releases.filter((r) => r.feature);
  const plain = releases.filter((r) => !r.feature);
  return (
    <>
      {features.map((r, i) => (
        <Drawing key={`${r.date}-${r.time}`} release={r} id={i === 0 ? `d-${date}` : undefined} />
      ))}
      {plain.length > 0 && <Day date={date} releases={plain} />}
    </>
  );
}

export default function ChangelogPage() {
  const data = useLoaderData<typeof loader>();
  useEffect(() => setChangelogSeen(data.latestVersion), [data.latestVersion]);
  const [kind, setKind] = useState<Release["kind"] | null>(null);
  const groups = new Map<string, Release[]>();
  for (const r of data.releases) if (!kind || r.kind === kind) groups.set(r.date, [...(groups.get(r.date) ?? []), r]);
  // Month → the newest date shown in it (the jump target) and how many entries it holds.
  const months = new Map<string, { first: string; count: number }>();
  for (const [date, releases] of groups) {
    const month = months.get(date.slice(0, 7)) ?? { first: date, count: 0 };
    month.count += releases.length;
    months.set(date.slice(0, 7), month);
  }

  const aside = (
    <>
      <AsideCard title="按类型看" className="hidden lg:block">
        <div className="-mx-2 -mb-1">
          {[null, ...KINDS].map((k) => (
            <button
              key={k ?? "all"}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={`flex w-full items-center gap-2.5 rounded-control px-2 py-2 text-left text-[13.5px] transition-colors ${kind === k ? "bg-bg-sunk font-medium text-ink dark:bg-bg-muted/60" : "text-ink-2 hover:bg-bg-sunk hover:text-ink"}`}
            >
              <span className={`size-1.5 rounded-full ${k ? KIND_DOT[k] : "bg-ink-2"}`} aria-hidden="true" />
              <span className="flex-1">{k ?? "全部"}</span>
              <span className="num text-[12px] text-ink-4">{k ? data.releases.filter((r) => r.kind === k).length : data.releases.length}</span>
            </button>
          ))}
        </div>
      </AsideCard>
      <AsideCard title="按月份" className="hidden lg:block">
        <nav aria-label="按月份" className="-mx-2 -mb-1">
          {[...months.entries()].map(([month, m]) => {
            const [y, mo] = month.split("-").map(Number) as [number, number];
            return (
              <a key={month} href={`#d-${m.first}`} className="flex items-center justify-between rounded-control px-2 py-2 text-[13.5px] text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink">
                {y} 年 {mo} 月<span className="num text-[12px] text-ink-4">{m.count} 条</span>
              </a>
            );
          })}
        </nav>
      </AsideCard>
      <AsideCard title="有想法或遇到问题">
        <p className="text-[13px] leading-[1.75] text-ink-3">想要的功能、用着不顺的地方，都可以在反馈页告诉我们。</p>
        <IntentLink viewTransition to="/feedback" className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">
          去反馈 <IconChevronRight size={14} />
        </IntentLink>
      </AsideCard>
    </>
  );

  return (
    <>
    <PhoneBar back={{ to: "/more", label: "我的" }} title="更新日志" />
    <ReadingLayout aside={aside}>
      <header className="pb-6">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">更新日志</h1>
        <p className="mt-1.5 text-[13px] text-ink-3">新功能、调整、下线，都写在这里。</p>
      </header>
      <div className="space-y-4">
        {[...groups.entries()].map(([date, releases]) => {
          if (SITE_FEATURE && releases.some((r) => r.feature)) return <FeatureDay key={date} date={date} releases={releases} Drawing={SITE_FEATURE} />;
          return <Day key={date} id={`d-${date}`} date={date} releases={releases} />;
        })}
      </div>
    </ReadingLayout>
    </>
  );
}
