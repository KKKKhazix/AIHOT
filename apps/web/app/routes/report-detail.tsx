import { data, useLoaderData } from "react-router";
import type { Route } from "./+types/report-detail";
import { isReportKey, REPORT_NAMES, REPORT_NAMES_EN, reportDateLabel, reportDateLabelEn, type ReportDetail, type ReportNavigationResponse } from "@aihot/contracts/reports";
import { SITE, subjectAfter, withSubject } from "@aihot/site";
import { cachedPage, loadOr404, pagePathname } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { breadcrumbLd, pageMeta, reportDescription, reportLd, reportTitle, titled, titleCacheSeconds } from "../lib/seo";
import { beijingDate } from "@aihot/contracts/time";
import { ReportLayout } from "../features/report/ReportLayout";
import { ReportPaper, reportOutline } from "../features/report/ReportPaper";
import { KIND_PATH, archiveGroups, feedLink, kindFromPath } from "../features/report/format";
import type { Screen } from "../components/shell/screens";
import { apiIn, L, localeOf, translator, useLocale } from "../lib/i18n";

// One module serves 日报, 周报 and 月报: a back button names the one it leads to.
export const handle: Screen = { tab: "daily", name: (path) => L(REPORT_NAMES[kindFromPath(path)], REPORT_NAMES_EN[kindFromPath(path)]) };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request, params }: Route.LoaderArgs) {
  const kind = kindFromPath(pagePathname(request));
  const locale = localeOf(pagePathname(request));
  const key = params.key ?? "";
  if (!isReportKey(kind, key)) throw data({ message: "not_found" }, { status: 404 });
  const [report, { items: index }] = await Promise.all([
    loadOr404<ReportDetail>(apiIn(`/reports/${kind}/${key}`, locale), { signal: request.signal }),
    loadOr404<ReportNavigationResponse>(apiIn(`/reports/${kind}/navigation/${key}`, locale), { signal: request.signal }),
  ]);
  const title = reportTitle(report, locale);
  return cachedPage(titleCacheSeconds(3600, locale, title), { report, title, index, today: beijingDate(Date.now()) });
}

export function meta({ loaderData, location }: Route.MetaArgs) {
  const locale = localeOf(location.pathname);
  const t = translator(locale);
  if (!loaderData) return [{ title: titled(t("报告不存在", "Report not found")) }, { name: "robots", content: "noindex" }];
  const r = loaderData.report;
  const description = reportDescription(r, locale) ?? t(`${SITE.name} ${r.key} ${subjectAfter("的", REPORT_NAMES[r.kind])}。`, `${SITE.name}'s ${withSubject(REPORT_NAMES_EN[r.kind])} for ${reportDateLabelEn(r.kind, r.key)}.`);
  const path = `/${r.kind}/${r.key}`;
  return [...pageMeta({
    locale,
    title: loaderData.title,
    description,
    path,
    image: `/og/reports/${r.kind}/${r.key}.png`,
    type: "article",
    jsonLd: [
      reportLd(r, path, description, locale),
      breadcrumbLd([
        { name: SITE.name, path: "/" },
        { name: t(withSubject(REPORT_NAMES[r.kind]), withSubject(REPORT_NAMES_EN[r.kind])), path: KIND_PATH[r.kind] },
        { name: t(reportDateLabel(r.kind, r.key), reportDateLabelEn(r.kind, r.key)), path },
      ], locale),
    ],
  }), feedLink(r.kind, locale)];
}

export default function ReportDetailPage() {
  const { report, index, today } = useLoaderData<typeof loader>();
  const locale = useLocale();
  return (
    <ReportLayout kind={report.kind} groups={archiveGroups(report.kind, index, locale)} current={report.key} today={today} outline={reportOutline(report, locale)}>
      <ReportPaper report={report} index={index} />
    </ReportLayout>
  );
}
