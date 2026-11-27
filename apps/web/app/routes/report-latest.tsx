import { useLoaderData } from "react-router";
import type { Route } from "./+types/report-latest";
import { REPORT_NAMES, REPORT_NAMES_EN, reportDateLabel, reportDateLabelEn, type ReportLatestPage } from "@aihot/contracts/reports";
import { REPORTS, SEO_TITLES, SITE, subjectAfter, withSubject } from "@aihot/site";
import { ENGLISH } from "@aihot/contracts/english";
import { cachedPage, loadOr404, pagePathname } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { breadcrumbLd, pageMeta, reportDescription, reportLd, titled } from "../lib/seo";
import { beijingDate } from "@aihot/contracts/time";
import { EmptyState } from "../components/ui/Page";
import { ReportLayout } from "../features/report/ReportLayout";
import { ReportPaper, reportOutline } from "../features/report/ReportPaper";
import { KIND_PATH, archiveGroups, feedLink, kindFromPath } from "../features/report/format";
import type { Screen } from "../components/shell/screens";
import { apiIn, L, localeOf, translator, useLocale, useT } from "../lib/i18n";

// One module serves 日报, 周报 and 月报: a back button names the one it leads to.
export const handle: Screen = { tab: "daily", name: (path) => L(REPORT_NAMES[kindFromPath(path)], REPORT_NAMES_EN[kindFromPath(path)]) };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request }: Route.LoaderArgs) {
  const kind = kindFromPath(pagePathname(request));
  const { index, report } = await loadOr404<ReportLatestPage>(apiIn(`/reports/${kind}/latest-page`, localeOf(pagePathname(request))), { signal: request.signal });
  return cachedPage(600, { kind, report, index, today: beijingDate(Date.now()) });
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const locale = localeOf(location.pathname);
  const t = translator(locale);
  const kind = loaderData?.kind ?? kindFromPath(location.pathname);
  const name = t(withSubject(REPORT_NAMES[kind]), withSubject(REPORT_NAMES_EN[kind]));
  if (!loaderData) return [{ title: titled(name) }];
  const report = loaderData.report;
  // What this issue says, so a search result shows today's date and news rather than what the page is.
  const description = (report && reportDescription(report, locale)) ?? t(`${REPORTS.descriptions[kind]}。`, `${ENGLISH?.reports.descriptions[kind] ?? REPORTS.descriptions[kind]}.`);
  // One address however it was written (/daily/, a different case): the router matches them all.
  const path = KIND_PATH[kind];
  return [...pageMeta({
    locale,
    title: report ? t(SEO_TITLES.latestReport(kind, reportDateLabel(kind, report.key)), (ENGLISH?.seoTitles ?? SEO_TITLES).latestReport(kind, reportDateLabelEn(kind, report.key))) : name,
    description,
    path,
    image: `/og/pages/${kind}.png`,
    // The latest issue, described at this page's own address (its canonical).
    jsonLd: [
      ...(report ? [reportLd(report, path, description, locale)] : []),
      breadcrumbLd([{ name: SITE.name, path: "/" }, { name, path }], locale),
    ],
  }), feedLink(kind, locale)];
}

export default function ReportLatestPage() {
  const { kind, report, index, today } = useLoaderData<typeof loader>();
  const locale = useLocale();
  const t = useT();
  return (
    <ReportLayout kind={kind} groups={archiveGroups(kind, index, locale)} current={report?.key ?? null} today={today} outline={report ? reportOutline(report, locale) : []}>
      {report ? <ReportPaper report={report} index={index} /> : <EmptyState title={t(subjectAfter("还没有发布", REPORT_NAMES[kind]), `No ${withSubject(REPORT_NAMES_EN[kind])} issues yet`)}>{t("第一期发布后会出现在这里。", "The first issue will appear here once it's out.")}</EmptyState>}
    </ReportLayout>
  );
}
