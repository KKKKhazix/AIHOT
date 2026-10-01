import { SITE } from "@aihot/industry/site";
import { Form, Link, useNavigate, useSearchParams } from "react-router";
import type { AdminSources } from "@aihot/contracts/admin";
import type { Route } from "./+types/sources";
import { adminGet } from "../../lib/admin.server";
import { num } from "../../features/admin/format";
import { HEALTH_LABEL, KIND_LABEL, MODE_LABEL } from "../../features/admin/labels";
import { AdminPage, Badge, ButtonLink, Card, DataTable, Dot, FilterChips, healthTone, Input, Pager, Select, Stat, Time } from "../../features/admin/ui";



export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return adminGet<AdminSources>(request, `/api/admin/sources${url.search}`);
}

export const meta: Route.MetaFunction = () => [{ title: `信源 · ${SITE.name} 后台` }];

export default function Sources({ loaderData }: Route.ComponentProps) {
  const { rows, totals, page } = loaderData;
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  return (
    <AdminPage
      title="信源"
      subtitle="列表按健康度排序：失败的在最前。点进详情可以预览抓取、手动采集、调整频率与参与方式。"
      actions={<ButtonLink to="/admin/sources/new" tone="primary">新建信源</ButtonLink>}
    >
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="全部" value={num(totals.total)} />
        <Stat label="启用" value={num(totals.enabled)} />
        <Stat label="失败" value={num(totals.failing)} tone={totals.failing ? "bad" : "ok"} />
        <Stat label="不稳定" value={num(totals.degraded)} tone={totals.degraded ? "warn" : undefined} />
      </div>
      <Card pad={false}>
        <div className="flex flex-col gap-3 border-b border-line p-3 lg:flex-row lg:items-center lg:justify-between">
          <Form method="get" className="flex w-full max-w-md gap-2" preventScrollReset>
            {["kind", "health", "mode"].map((k) => sp.get(k) && <input key={k} type="hidden" name={k} value={sp.get(k)!} />)}
            <Input name="q" defaultValue={sp.get("q") ?? ""} placeholder="名称、ID 或地址" aria-label="搜索信源" />
          </Form>
          <div className="flex flex-wrap items-center gap-3">
            <FilterChips param="health" options={[{ value: "", label: "全部" }, { value: "failing", label: "失败" }, { value: "degraded", label: "不稳定" }, { value: "paused", label: "暂停" }]} />
            <Select
              aria-label="类型"
              className="!w-auto"
              value={sp.get("kind") ?? ""}
              onChange={(e) => {
                const next = new URLSearchParams(sp);
                if (e.target.value) next.set("kind", e.target.value);
                else next.delete("kind");
                next.delete("page");
                navigate(`?${next}`, { preventScrollReset: true });
              }}
            >
              <option value="">全部类型</option>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </Select>
          </div>
        </div>
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/admin/sources/${encodeURIComponent(r.id)}`)}
          columns={[
            {
              key: "name",
              label: "信源",
              render: (r) => (
                <div className="min-w-[220px]">
                  <Link to={`/admin/sources/${encodeURIComponent(r.id)}`} className="font-medium text-ink hover:text-accent" onClick={(e) => e.stopPropagation()}>
                    {r.name}
                  </Link>
                  <div className="font-mono text-[11.5px] text-ink-4">{r.id}</div>
                  {r.health === "failing" && r.last_error && <div className="mt-1 line-clamp-1 text-[12px] text-hot">{r.last_error}</div>}
                </div>
              ),
            },
            { key: "kind", label: "类型", render: (r) => <Badge>{KIND_LABEL[r.kind] ?? r.kind}</Badge> },
            {
              key: "mode",
              label: "参与",
              render: (r) => (
                <div className="flex gap-1">
                  <Badge tone={r.participation_mode === "editorial" ? "accent" : "muted"}>{MODE_LABEL[r.participation_mode] ?? r.participation_mode}</Badge>
                  <Badge tone="info">{r.tier.replace("_", ".")}</Badge>
                  {r.first_party && <Badge tone="ok">一手</Badge>}
                </div>
              ),
            },
            {
              key: "health",
              label: "健康",
              render: (r) => (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  <Dot tone={r.enabled ? healthTone(r.health) : "muted"} />
                  {r.enabled ? HEALTH_LABEL[r.health] ?? r.health : "已暂停"}
                  {r.fail_count > 0 && <span className="num text-[11.5px] text-ink-4">×{r.fail_count}</span>}
                </span>
              ),
            },
            { key: "ok", label: "上次成功", render: (r) => <Time at={r.last_ok_at} /> },
            { key: "interval", label: "频率", align: "right", render: (r) => `${r.interval_minutes} 分` },
            { key: "items", label: "7 天条目", align: "right", render: (r) => num(r.items_7d) },
            { key: "sel", label: "30 天精选", align: "right", render: (r) => num(r.selected_30d) },
          ]}
        />
      </Card>
      <Pager page={page} hasMore={rows.length === 100} />
    </AdminPage>
  );
}
