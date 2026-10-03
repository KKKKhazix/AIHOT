import { data, useLoaderData } from "react-router";
import type { Route } from "./+types/report-detail";
import type { ReportDetail, ReportNavigationResponse, ReportKind } from "@aihot/contracts/site";
import { SITE, subjectAfter, withSubject } from "@aihot/site";
import { apiGet, edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta, reportLd, titled } from "../lib/seo";
import { beijingDate } from "@aihot/contracts/time";
import { ReportLayout } from "../features/report/ReportLayout";
import { ReportPaper, reportOutline } from "../features/report/ReportPaper";
import { KIND_LABEL, feedLink, kindFromPath } from "../features/report/format";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "daily", name: "日报" };

const PATTERN: Record<ReportKind, RegExp> = {
  daily: /^\d{4}-\d{2}-\d{2}$/,
  weekly: /^\d{4}-W\d{2}$/,
  monthly: /^\d{4}-\d{2}$/,
};

export async function loader({ request, params }: Route.LoaderArgs) {
  const kind = kindFromPath(new URL(request.url).pathname);
  const key = params.key ?? "";
  if (!PATTERN[kind].test(key)) throw data({ message: "not_found" }, { status: 404 });
  const [report, { items: index }] = await Promise.all([
    loadOr404<ReportDetail>(`/api/site/reports/${kind}/${key}`, { signal: request.signal }),
    apiGet<ReportNavigationResponse>(`/api/site/reports/${kind}/navigation/${key}`, { signal: request.signal }),
  ]);
  return { report, index, today: beijingDate(Date.now()) };
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("报告不存在") }, { name: "robots", content: "noindex" }];
  const r = loaderData.report;
  const description = r.lead?.leadParagraph ?? r.overview?.slice(0, 150) ?? `${SITE.name} ${r.key} ${subjectAfter("的", KIND_LABEL[r.kind])}。`;
  const path = `/${r.kind}/${r.key}`;
  return [...pageMeta({
    title: r.kind === "daily" ? `${withSubject("日报")} ${r.key}` : r.title.replace(`${SITE.name} ${KIND_LABEL[r.kind]}`, withSubject(KIND_LABEL[r.kind])),
    description,
    path,
    image: `/og/reports/${r.kind}/${r.key}.png`,
    type: "article",
    jsonLd: reportLd(r, path, description),
  }), feedLink(r.kind)];
}

export function headers() {
  return edgeTtl(3600);
}

export default function ReportDetailPage() {
  const { report, index, today } = useLoaderData<typeof loader>();
  return (
    <ReportLayout kind={report.kind} index={index} current={report.key} today={today} outline={reportOutline(report)}>
      <ReportPaper report={report} index={index} />
    </ReportLayout>
  );
}
