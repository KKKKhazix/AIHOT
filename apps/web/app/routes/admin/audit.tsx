import { SITE } from "@aihot/site";
import { Form, Link, useSearchParams } from "react-router";
import type { Route } from "./+types/audit";
import type { AdminAudit, AdminAuditRow } from "@aihot/contracts/admin";
import { adminGet } from "../../lib/admin.server";
import { bj } from "../../features/admin/format";
import { AdminPage, Card, DataTable, Input, Json, Pager } from "../../features/admin/ui";


export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<AdminAudit>(request, `/api/admin/audit${new URL(request.url).search}`);
}

export const meta: Route.MetaFunction = () => [{ title: `审计记录 · ${SITE.name} 后台` }];

function subjectLink(subject: string | null) {
  if (!subject) return null;
  const [kind, id] = [subject.slice(0, subject.indexOf(":")), subject.slice(subject.indexOf(":") + 1)];
  if (kind === "content") return <Link className="text-accent" to={`/admin/content/${id}`}>{subject}</Link>;
  if (kind === "source") return <Link className="text-accent" to={`/admin/sources/${encodeURIComponent(id)}`}>{subject}</Link>;
  return <span className="font-mono text-[12px]">{subject}</span>;
}

export default function Audit({ loaderData }: Route.ComponentProps) {
  const [sp] = useSearchParams();
  return (
    <AdminPage title="审计记录" subtitle="所有人工操作：谁、何时、改了什么、为什么。">
      <Form method="get" className="mb-4 flex max-w-xl gap-2">
        <Input name="action" defaultValue={sp.get("action") ?? ""} placeholder="操作前缀，例如 content. 或 source." aria-label="按操作筛选" />
        <Input name="subject" defaultValue={sp.get("subject") ?? ""} placeholder="对象，例如 source:openai-blog" aria-label="按对象筛选" />
      </Form>
      <Card pad={false}>
        <DataTable
          rows={loaderData.rows}
          rowKey={(r) => r.id}
          empty="没有记录"
          columns={[
            { key: "t", label: "时间", render: (r) => <span className="num whitespace-nowrap">{bj(r.created_at, true)}</span> },
            { key: "a", label: "操作", render: (r) => <span className="font-mono text-[12.5px] text-ink">{r.action}</span> },
            { key: "s", label: "对象", render: (r) => subjectLink(r.subject) },
            { key: "who", label: "操作人", render: (r) => r.actor },
            { key: "r", label: "原因", render: (r) => <span className="text-ink-2">{r.reason}</span> },
            { key: "d", label: "变化", render: (r) => (r.before || r.after ? <Json value={{ before: r.before, after: r.after }} label="前后" /> : null) },
          ]}
        />
      </Card>
      <Pager page={loaderData.page} hasMore={loaderData.rows.length === 100} />
    </AdminPage>
  );
}
