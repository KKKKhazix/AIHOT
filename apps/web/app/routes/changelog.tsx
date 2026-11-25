import { useEffect, useState, type ComponentType } from "react";
import { IntentLink } from "../components/ui/IntentLink";
import type { ChangelogRelease, ChangelogResponse } from "@aihot/contracts/site";
import { SITE } from "@aihot/site";
import { apiIn, L, localeOf, translator, useLocale, useT } from "../lib/i18n";
import { useLoaderData, type MetaFunction } from "react-router";
import { apiGet, cachedPage, pagePathname } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { breadcrumbLd, pageMeta } from "../lib/seo";
import { setChangelogSeen } from "../lib/local-state";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { IconChevronRight } from "../components/icons";
import { Inline, dateHeading } from "../features/changelog/text";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "me", name: L("更新日志", "Changelog") };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

type Release = ChangelogRelease;

export async function loader({ request }: { request: Request }) {
  return cachedPage(300, await apiGet<ChangelogResponse>(apiIn("/changelog", localeOf(pagePathname(request))), { signal: request.signal }));
}

export const meta: MetaFunction = ({ location }) => {
  const locale = localeOf(location.pathname);
  const t = translator(locale);
  return pageMeta({
    locale,
    title: t("更新日志", "Changelog"),
    description: t(`${SITE.name} 的功能更新、优化、公告与下线记录。`, `Features, improvements, announcements and retirements at ${SITE.name}.`),
    path: "/changelog",
    image: "/og/pages/changelog.png",
    jsonLd: breadcrumbLd([{ name: SITE.name, path: "/" }, { name: L("更新日志", "Changelog"), path: "/changelog" }], locale),
  });
};

const KIND_DOT: Record<Release["kind"], string> = {
  更新: "bg-accent",
  优化: "bg-ok",
  公告: "bg-amber",
  下线: "bg-ink-4",
};

const KIND_NAMES = { 更新: L("更新", "Updates"), 优化: L("优化", "Improvements"), 公告: L("公告", "Announcements"), 下线: L("下线", "Retirements") };

const KINDS = Object.keys(KIND_DOT) as Release["kind"][];

function ReleaseBody({ lines }: { lines: string[] }) {
  const blocks: Array<string | string[]> = [];
  for (const line of lines) {
    const last = blocks.at(-1);
    if (!line.startsWith("- ")) blocks.push(line);
    else if (Array.isArray(last)) last.push(line.slice(2));
    else blocks.push([line.slice(2)]);
  }
  const text = "mt-2 max-w-[52em] text-ui-label-lg leading-[1.8] text-ink-3";
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
  const t = useT();
  const h = dateHeading(date, useLocale());
  return (
    <section id={id} className="card scroll-mt-[calc(var(--bar-h)+1.5rem)] px-5 lg:px-7">
      <h2 className="flex items-baseline gap-3 border-b border-line-soft py-4">
        <time dateTime={date} className="text-ui-heading-sm font-bold text-ink">
          {h.label}
        </time>
        <span className="text-ui-caption text-ink-4">{h.weekday}</span>
      </h2>
      <ol>
        {releases.map((r) => (
          <li
            key={r.id ?? `${r.date}-${r.time}-${r.title}`}
            id={r.id ? `r-${r.id}` : undefined}
            className={`grid gap-x-8 gap-y-2 border-b border-line-soft py-5 last:border-b-0 sm:grid-cols-[88px_minmax(0,1fr)] ${r.urgent ? "-mx-5 border-l-4 border-l-hot bg-hot-soft pl-4 pr-5 lg:-mx-7 lg:pl-6 lg:pr-7" : ""}`}
          >
            <div className="flex items-center gap-3 sm:block">
              <span className="mono block text-ui-caption-lg text-ink-3">{r.time}</span>
              <span className="inline-flex items-center gap-1.5 text-ui-caption-md text-ink-4 sm:mt-1.5">
                <span className={`size-1.5 rounded-full ${r.urgent ? "bg-hot" : KIND_DOT[r.kind]}`} aria-hidden="true" />
                {t(KIND_NAMES[r.kind])}
              </span>
            </div>
            <article className={`min-w-0 sm:border-l sm:pl-8 ${r.urgent ? "sm:border-hot/40" : "sm:border-line"}`}>
              {r.urgent && <span className="mb-2 inline-flex rounded-full bg-hot px-2.5 py-0.5 text-ui-caption font-semibold text-white">{t("重要", "Important")}</span>}
              <h3 className={`text-ui-body font-bold leading-snug ${r.urgent ? "text-hot" : "text-ink"}`}>{r.title}</h3>
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
        <Drawing key={r.id ?? `${r.date}-${r.time}`} release={r} id={i === 0 ? `d-${date}` : (r.id ? `r-${r.id}` : undefined)} />
      ))}
      {plain.length > 0 && <Day date={date} releases={plain} />}
    </>
  );
}

export default function ChangelogPage() {
  const t = useT();
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
      <AsideCard title={t("按类型看", "Filter by type")} className="hidden side:block">
        <div className="-mx-2 -mb-1">
          {[null, ...KINDS].map((k) => (
            <button
              key={k ?? "all"}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={`flex w-full items-center gap-2.5 rounded-control px-2 py-2 text-left text-ui-label-lg transition-colors ${kind === k ? "bg-well font-medium text-ink" : "text-ink-2 hover:bg-bg-sunk hover:text-ink"}`}
            >
              <span className={`size-1.5 rounded-full ${k ? KIND_DOT[k] : "bg-ink-2"}`} aria-hidden="true" />
              <span className="flex-1">{k ? t(KIND_NAMES[k]) : t("全部", "All")}</span>
              <span className="num text-ui-caption text-ink-4">{k ? data.releases.filter((r) => r.kind === k).length : data.releases.length}</span>
            </button>
          ))}
        </div>
      </AsideCard>
      <AsideCard title={t("按月份", "By month")} className="hidden side:block">
        <nav aria-label={t("按月份", "By month")} className="-mx-2 -mb-1">
          {[...months.entries()].map(([month, m]) => {
            const [y, mo] = month.split("-").map(Number) as [number, number];
            return (
              <a key={month} href={`#d-${m.first}`} className="flex items-center justify-between rounded-control px-2 py-2 text-ui-label-lg text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink">
                {t(`${y} 年 ${mo} 月`, new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(month + "-01")))}<span className="num text-ui-caption text-ink-4">{t(`${m.count} 条`, String(m.count))}</span>
              </a>
            );
          })}
        </nav>
      </AsideCard>
      <AsideCard title={t("有想法或遇到问题", "Ideas or problems?")}>
        <p className="text-ui-label leading-[1.75] text-ink-3">{t("想要的功能、用着不顺的地方，都可以在反馈页告诉我们。", "Tell us what you’d like to see or what isn’t working for you.")}</p>
        <IntentLink viewTransition to="/feedback" className="mt-3 inline-flex items-center gap-1 text-ui-label font-medium text-accent hover:underline">
          {t("去反馈", "Send feedback")} <IconChevronRight size={14} />
        </IntentLink>
      </AsideCard>
    </>
  );

  return (
    <>
    <PhoneBar back={{ to: "/more", label: t("我的", "Me") }} title={t("更新日志", "Changelog")} />
    <ReadingLayout aside={aside}>
      <header className="pb-6">
        <h1 data-page-title="" className="text-ui-heading-lg font-semibold leading-[1.3] text-ink">{t("更新日志", "Changelog")}</h1>
        <p className="mt-1.5 text-ui-label text-ink-3">{t("新功能、调整、下线，都写在这里。", "New features, improvements and retirements.")}</p>
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
