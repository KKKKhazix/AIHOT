import { SITE } from "@aihot/site";
import { Form, Link, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/content";
import type { AdminContentRow, AdminContentSearch } from "@aihot/contracts/admin";
import { adminGet } from "../../lib/admin.server";
import { VISIBILITY_LABEL } from "../../features/admin/labels";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Input, Time } from "../../features/admin/ui";


export async function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  const q = params.get("q")?.trim() ?? "";
  const editorialCases = params.get("view") === "editorial-cases";
  if (!q && !editorialCases) return { q, editorialCases, rows: [] as AdminContentRow[] };
  const query = editorialCases ? "view=editorial-cases" : `q=${encodeURIComponent(q)}`;
  const { rows } = await adminGet<AdminContentSearch>(request, `/api/admin/content?${query}`);
  return { q, editorialCases, rows };
}

export const meta: Route.MetaFunction = () => [{ title: `内容诊断 · ${SITE.name} 后台` }];

export default function Content({ loaderData }: Route.ComponentProps) {
  const { q, rows, editorialCases } = loaderData;
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  return (
    <AdminPage title="内容诊断" subtitle="按 ID、原文链接或标题找到任何一条内容，看它从信源到公开出口的完整链路；下架、仅摘要、人工修正和重处理都在详情页。">
      <p className="mb-4"><Link className="text-accent hover:underline" to={editorialCases ? "/admin/content" : "/admin/content?view=editorial-cases"}>{editorialCases ? "返回内容搜索" : "创作与运营案例（内部研究）"}</Link></p>
      {editorialCases && <p className="mb-4 text-sm">创作与运营案例：最近 50 条匹配内容工作流、创作者案例拆解或内容运营方法的资料。</p>}
      <Form method="get" className="mb-5 flex max-w-2xl gap-2">
        <Input name="q" defaultValue={sp.get("q") ?? ""} placeholder="内容 ID、URL 或标题关键词" aria-label="搜索内容" autoFocus />
        <Button type="submit" tone="primary">查找</Button>
      </Form>
      {(q || editorialCases) && (
        <Card pad={false} title={editorialCases ? "创作与运营案例" : `“${q}” 的结果`} right={<span>{rows.length === 50 ? "仅显示最近 50 条" : `${rows.length} 条`}</span>}>
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/admin/content/${r.id}`)}
            empty="没有找到。URL 会先规范化再比对；标题支持中英文片段。"
            columns={[
              {
                key: "t",
                label: "标题",
                render: (r) => (
                  <div className="min-w-[320px]">
                    <Link to={`/admin/content/${r.id}`} className="font-medium text-ink hover:text-accent" onClick={(e) => e.stopPropagation()}>{r.title}</Link>
                    <div className="font-mono text-[11.5px] text-ink-4">{r.id}</div>
                  </div>
                ),
              },
              { key: "src", label: "信源", render: (r) => <span className="whitespace-nowrap">{r.source}</span> },
              {
                key: "st",
                label: "状态",
                render: (r) => (
                  <span className="flex flex-wrap gap-1">
                    {r.selected && <Badge tone="accent">精选</Badge>}
                    {r.visibility && <Badge tone={r.visibility === "public" ? "muted" : "warn"}>{VISIBILITY_LABEL[r.visibility] ?? r.visibility}</Badge>}
                    {!r.visibility && <Badge>{r.processing_state}</Badge>}
                  </span>
                ),
              },
              { key: "sc", label: "分数", align: "right", render: (r) => r.score ?? "—" },
              { key: "d", label: "发现", render: (r) => <Time at={r.discovered_at} /> },
            ]}
          />
        </Card>
      )}
      {!q && !editorialCases && <Empty>输入 ID、链接或标题开始查找。</Empty>}
    </AdminPage>
  );
}
