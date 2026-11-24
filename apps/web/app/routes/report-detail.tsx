import { data, useLoaderData } from "react-router";
import type { Route } from "./+types/report-detail";
import { REPORT_NAMES, REPORT_NAMES_EN, reportDateLabel, reportDateLabelEn, type ReportDetail, type ReportNavigationResponse, type ReportKind } from "@aihot/contracts/site";
import { SITE, subjectAfter, withSubject } from "@aihot/site";
import { apiGet, cachedPage, loadOr404, pagePathname } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { breadcrumbLd, pageMeta, reportDescription, reportLd, reportTitle, titled } from "../lib/seo";
import { beijingDate } from "@aihot/contracts/time";
import { ReportLayout } from "../features/report/ReportLayout";
import { ReportPaper, reportOutline } from "../features/report/ReportPaper";
import { KIND_PATH, feedLink, kindFromPath } from "../features/report/format";
import type { Screen } from "../components/shell/screens";
import { L, localeOf, translator, useLocale } from "../lib/i18n";

export const handle: Screen = { tab: "daily", name: L("日报", "Daily") };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

const PATTERN: Record<ReportKind, RegExp> = {
  daily: /^\d{4}-\d{2}-\d{2}$/,
  weekly: /^\d{4}-W\d{2}$/,
  monthly: /^\d{4}-\d{2}$/,
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const kind = kindFromPath(pagePathname(request));
  const key = params.key ?? "";
  if (!PATTERN[kind].test(key)) throw data({ message: "not_found" }, { status: 404 });
  const [report, { items: index }] = await Promise.all([
    loadOr404<ReportDetail>(`/api/site/reports/${kind}/${key}`, { signal: request.signal }),
    apiGet<ReportNavigationResponse>(`/api/site/reports/${kind}/navigation/${key}`, { signal: request.signal }),
  ]);
  return cachedPage(3600, { report, index, today: beijingDate(Date.now()) });
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
    title: reportTitle(r, locale),
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
    <ReportLayout kind={report.kind} index={index} current={report.key} today={today} outline={reportOutline(report, locale)}>
      <ReportPaper report={report} index={index} />
    </ReportLayout>
  );
}
