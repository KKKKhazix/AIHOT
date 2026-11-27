import { useLoaderData } from "react-router";
import { IntentLink } from "../components/ui/IntentLink";
import { REPORT_NAMES_EN, type ReportIndexEntry, type ReportIndexResponse } from "@aihot/contracts/reports";
import { SITE, withSubject } from "@aihot/site";
import { cachedPage, loadOr404, pagePathname } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { archiveLd, breadcrumbLd, pageMeta } from "../lib/seo";
import { beijingDate } from "@aihot/contracts/time";
import { weekdayShort } from "../lib/format";
import { ReportLayout } from "../features/report/ReportLayout";
import { archiveGroups, entriesUnit } from "../features/report/format";
import { Rows, SectionPage } from "../features/report/ReportPaper";
import { Nameplate } from "../features/report/Nameplate";
import type { Screen } from "../components/shell/screens";
import { formatCount } from "../lib/format";
import { apiIn, L, localeOf, translator, useLocale, useT } from "../lib/i18n";

export const handle: Screen = { tab: "daily", name: L("合订本", "Archive") };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request }: { request: Request }) {
  const { items: index } = await loadOr404<ReportIndexResponse>(apiIn("/reports/daily", localeOf(pagePathname(request))), { signal: request.signal });
  return cachedPage(600, { index, today: beijingDate(Date.now()) });
}

export function meta({ loaderData, location }: { loaderData?: { index: ReportIndexEntry[] }; location: { pathname: string } }) {
  const locale = localeOf(location.pathname);
  const t = translator(locale);
  const daily = REPORT_NAMES_EN.daily;
  const entries = (loaderData?.index ?? []).map((e: ReportIndexEntry) => ({ path: `/daily/${e.key}`, name: e.title ? `${e.key} · ${e.title}` : t(`${SITE.name} 日报 · ${e.key}`, `${SITE.name} ${daily} · ${e.key}`) }));
  return pageMeta({
    locale,
    title: t(`${withSubject("日报")} · 历史存档`, `${withSubject(daily)} · Archive`),
    description: t(`${SITE.name} 历史日报，按日期归档。`, `Past issues of ${SITE.name}'s ${withSubject(daily)}, archived by date.`),
    path: "/daily/archive",
    image: "/og/pages/daily.png",
    jsonLd: [
      archiveLd("/daily/archive", t(`${SITE.name} 日报 · 历史存档`, `${SITE.name} ${daily} · Archive`), entries, locale),
      breadcrumbLd([
        { name: SITE.name, path: "/" },
        { name: t(withSubject("日报"), withSubject(daily)), path: "/daily" },
        { name: t("历史存档", "Archive"), path: "/daily/archive" },
      ], locale),
    ],
  });
}

export default function DailyArchive() {
  const { index, today } = useLoaderData<typeof loader>();
  const locale = useLocale();
  const t = useT();
  const months = archiveGroups("daily", index, locale);
  const issues = index[0]?.issueNumber ?? 0;
  return (
    <ReportLayout kind="daily" groups={months} current={null} today={today} back={{ to: "/daily", label: L("日报", "Daily") }} title={t("日报合订本", "Daily archive")}>
      <div className="@container">
        <header className="pt-5 lg:pt-0">
          <div className="flex items-center justify-between gap-4 text-ui-caption text-ink-4">
            <span>{t(`${SITE.name} · ${withSubject("日报")}`, `${SITE.name} · ${withSubject(REPORT_NAMES_EN.daily)}`)}</span>
            <span>
              {t(<>共 <span className="num">{issues}</span> 期</>, <><span className="num">{formatCount(issues, "en")}</span> {issues === 1 ? "issue" : "issues"}</>)}
            </span>
          </div>
          <div className="py-6 @[880px]:py-8">
            <h1 id="report-start" data-page-title="">
              <span className="sr-only">{t("日报合订本", "Daily archive")}</span>
              <Nameplate which="archive" className="block h-[50px] w-auto @[520px]:h-[70px] @[880px]:h-[98px]" />
            </h1>
          </div>
          <div aria-hidden="true" className="border-t border-line-strong" />
        </header>
        {months.map((m) => (
          <SectionPage key={m.id} id={`m-${m.id}`} label={m.label}>
            <Rows items={m.entries}>
              {(e, cell) => (
                <IntentLink viewTransition key={e.key} to={`/daily/${e.key}`} className={`group flex gap-4 py-4 ${cell}`}>
                  <span className="flex w-9 shrink-0 flex-col items-center">
                    <span className="num text-ui-heading-lg font-black leading-none tracking-[-0.03em] text-ink transition-colors group-hover:text-accent">{e.key.slice(8, 10)}</span>
                    <span className="mt-1.5 text-ui-micro-8 leading-none text-ink-4">{weekdayShort(e.key, locale)}</span>
                  </span>
                  <span className="min-w-0">
                    <span className="block text-ui-body font-bold leading-[1.55] text-ink transition-colors group-hover:text-accent">{e.title ?? t(`${withSubject("日报")} ${e.key}`, `${withSubject(REPORT_NAMES_EN.daily)} ${e.key}`)}</span>
                    {!!e.count && (
                      <span className="mt-1 block text-ui-caption text-ink-4">
                        <span className="num">{e.count}</span>{` ${entriesUnit(e.count, locale)}`}
                      </span>
                    )}
                  </span>
                </IntentLink>
              )}
            </Rows>
          </SectionPage>
        ))}
      </div>
    </ReportLayout>
  );
}
