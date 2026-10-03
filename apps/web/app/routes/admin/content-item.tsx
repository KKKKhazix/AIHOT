import { SITE } from "@aihot/site";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { CATEGORY_KEYS, CATEGORY_LABELS } from "@aihot/contracts/taxonomy";
import type { Route } from "./+types/content-item";
import type { AdminContentChain } from "@aihot/contracts/admin";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, money } from "../../features/admin/format";
import { KIND_LABEL, MODE_LABEL, VISIBILITY_LABEL } from "../../features/admin/labels";
import { AdminPage, Badge, Button, Card, Empty, Field, Input, Json, KV, ReasonDialog, Select, Textarea } from "../../features/admin/ui";


export async function loader({ request, params }: Route.LoaderArgs) {
  return adminGet<AdminContentChain>(request, `/api/admin/content/${encodeURIComponent(params.id)}`);
}

export const meta: Route.MetaFunction = ({ loaderData }) => [{ title: `${loaderData?.publication?.title ?? loaderData?.article.title ?? "内容"} · ${SITE.name} 后台` }];

function Step({ title, meta, children, tone = "accent", last }: { title: ReactNode; meta?: ReactNode; children: ReactNode; tone?: "accent" | "muted" | "bad"; last?: boolean }) {
  const dot = tone === "bad" ? "bg-hot" : tone === "muted" ? "bg-ink-4" : "bg-accent";
  return (
    <li className="relative pl-7">
      {!last && <span className="absolute left-[7px] top-4 h-full w-px bg-line-strong" aria-hidden />}
      <span className={`absolute left-[3px] top-[7px] size-[9px] rounded-full ring-4 ring-bg ${dot}`} aria-hidden />
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
        {meta && <div className="text-[12px] text-ink-4">{meta}</div>}
      </div>
      <div className="mt-2 pb-6 text-[13px] text-ink-2">{children}</div>
    </li>
  );
}

type Dialog = null | "visibility" | "seo" | "override" | "analyze" | "extract" | "group" | "detach" | "merge";

export default function ContentItem({ loaderData }: Route.ComponentProps) {
  const c = loaderData;
  const a = c.article;
  const p = c.publication;
  const { run, pending } = useAdminAction();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [visibility, setVisibility] = useState<string>(p?.visibility ?? "public");
  const [fields, setFields] = useState({ title: "", summary: "", reason: "", category: "", tags: "", selected: "", silent: "" });
  const [mergeInto, setMergeInto] = useState("");
  const version = c.override?.version ?? 0;
  const base = `/api/admin/content/${encodeURIComponent(a.id)}`;
  const story = c.membership[0];
  const title = p?.title ?? a.title;

  const openOverride = () => {
    const f = (c.override?.fields ?? {}) as Record<string, unknown>;
    setFields({
      title: String(f.title ?? ""),
      summary: String(f.summary ?? ""),
      reason: String(f.reason ?? ""),
      category: String(f.category ?? ""),
      tags: Array.isArray(f.tags) ? (f.tags as string[]).join(", ") : "",
      selected: f.selected === undefined ? "" : String(f.selected),
      silent: f.silent === undefined ? "" : String(f.silent),
    });
    setDialog("override");
  };

  return (
    <AdminPage
      title={<span className="line-clamp-2">{title}</span>}
      subtitle={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-[12px]">{a.id}</span>
          <span>·</span>
          <Link className="hover:text-accent" to={`/admin/sources/${encodeURIComponent(a.source_id)}`}>{a.source_name}</Link>
          <span>·</span>
          <a className="max-w-[420px] truncate hover:text-accent" href={a.url} target="_blank" rel="noreferrer">{a.url}</a>
          {p?.visibility !== "withdrawn" && p && (
            <>
              <span>·</span>
              <a className="text-accent" href={`/items/${a.id}`} target="_blank" rel="noreferrer">公开页</a>
            </>
          )}
        </span>
      }
      actions={
        <>
          <Button onClick={() => setDialog("visibility")}>公开范围</Button>
          {p && <Button onClick={() => setDialog("seo")}>{p.indexable ? "取消收录" : "标记收录"}</Button>}
          <Button onClick={openOverride}>人工修正</Button>
          <Button onClick={() => setDialog("analyze")}>重新评估</Button>
        </>
      }
    >
      <div className="mb-5 flex flex-wrap gap-1.5">
        {p ? <Badge tone={p.visibility === "public" ? "ok" : "warn"}>{VISIBILITY_LABEL[p.visibility] ?? p.visibility}</Badge> : <Badge>未公开</Badge>}
        {p?.selected && <Badge tone="accent">精选</Badge>}
        {p?.eligible === false && <Badge>不进公开面</Badge>}
        {a.backfill && <Badge tone="warn">历史回灌</Badge>}
        <Badge>处理 {a.processing_state}</Badge>
        {c.override && <Badge tone="info" title={c.override.reason ?? undefined}>有人工设置 v{c.override.version}</Badge>}
      </div>
      {a.processing_error && <div className="mb-5 rounded-card bg-hot-soft px-4 py-3 text-[13px] text-hot ring-1 ring-hot/20">{a.processing_error}</div>}

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <Card title="处理链路">
          <ol className="pt-1">
            <Step title="信源" meta={`${KIND_LABEL[a.source_kind] ?? a.source_kind} · ${String(a.tier).replace("_", ".")} · ${MODE_LABEL[a.participation_mode] ?? a.participation_mode}`}>
              <Link className="text-ink hover:text-accent" to={`/admin/sources/${encodeURIComponent(a.source_id)}`}>{a.source_name}</Link>
              <span className="text-ink-4"> · 站内全文 {a.site_fulltext ? "允许" : "不允许"} · 对外全文 {a.syndicate_fulltext ? "允许" : "不允许"}</span>
            </Step>
            <Step title="发现" meta={`${c.discoveries.length} 次`}>
              <ul className="space-y-1">
                {c.discoveries.map((d, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="num text-ink-4">{bj(d.discovered_at, true)}</span>
                    <span>{d.via}</span>
                    {d.source_id !== a.source_id && <span className="text-ink-3">经 {d.source_id}</span>}
                  </li>
                ))}
              </ul>
              <div className="mt-1.5 text-[12px] text-ink-4">
                原文时间 {a.published_at ? bj(a.published_at, true) : "未知"}{a.published_at_claim && !a.published_at ? `（声称 ${a.published_at_claim}，未采信）` : ""} · 时间轴 {bj(a.timeline_at, true)}
              </div>
            </Step>
            <Step title="正文与修订" meta={`第 ${a.revision} 版 · 正文 ${a.body_status} · ${a.body_chars ?? 0} 字符`}>
              {c.revisions.length ? (
                <ul className="space-y-1">
                  {c.revisions.map((r) => (
                    <li key={r.revision} className="flex gap-2">
                      <span className="num text-ink-4">v{r.revision}</span>
                      <span className="min-w-0 flex-1 truncate">{r.title}</span>
                      <span className="num shrink-0 text-ink-4">{bj(r.created_at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-ink-4">只有初始版本</span>
              )}
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => setDialog("extract")}>重新抽取正文</Button>
              </div>
            </Step>
            <Step title="模型判断" meta={`${c.analyses.length} 次`} tone={c.analyses.length ? "accent" : "muted"}>
              {c.analyses.length ? (
                <div className="space-y-3">
                  {c.analyses.map((an) => (
                    <div key={an.id} className="rounded-control bg-bg-sunk/60 p-3 ring-1 ring-line">
                      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
                        <Badge tone={an.relevance === "pass" ? "ok" : "muted"}>{an.relevance}</Badge>
                        {an.selected && <Badge tone="accent">入选</Badge>}
                        <Badge tone="info">分数 {an.score}</Badge>
                        {an.category && <Badge>{CATEGORY_LABELS[an.category as keyof typeof CATEGORY_LABELS] ?? an.category}</Badge>}
                        <span className="text-ink-4">{an.model} · {an.prompt_version} · 输入 v{an.input_revision} · {an.origin} · {bj(an.created_at)}</span>
                      </div>
                      {an.title_zh && <div className="mt-2 font-medium text-ink">{an.title_zh}</div>}
                      {an.reason_zh && <div className="mt-1 text-[12.5px] leading-relaxed text-ink-3">{an.reason_zh}</div>}
                      {an.receipts.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5 text-[11.5px]">
                          {an.receipts.map((r) => (
                            <span key={r.id} className="num rounded bg-surface px-1.5 py-0.5 text-ink-3 ring-1 ring-line">
                              回执 #{r.id} · {r.status} · {r.model ?? r.service}{r.cost !== null ? ` · ${money(r.cost)}` : ""}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <span className="text-ink-4">{a.participation_mode === "editorial" ? "还没有判断（等待队列或失败）" : "氛围信源不做编辑判断"}</span>
              )}
            </Step>
            <Step title="公开" tone={p ? (p.visibility === "withdrawn" ? "bad" : "accent") : "muted"} meta={p ? `更新于 ${bj(p.updated_at, true)}` : undefined}>
              {p ? (
                <KV
                  items={[
                    ["范围", VISIBILITY_LABEL[p.visibility] ?? p.visibility],
                    ["精选", p.selected ? `是 · 可见于 ${p.visible_after ? bj(p.visible_after, true) : "立即"}` : "否"],
                    ["栏目", p.category ? CATEGORY_LABELS[p.category as keyof typeof CATEGORY_LABELS] ?? p.category : null],
                    ["标签", (p.tags as string[] | null)?.join("、")],
                    ["摘要", p.summary],
                    ["推荐理由", p.reason],
                    [
                      "正文展示",
                      `${p.body_mode}${p.syndicate ? " · 对外可带全文" : ""}${
                        p.indexable ? (p.seo_indexed_at ? " · 可收录（手动标记）" : " · 可收录（精选自动）") : p.seo_excluded_at ? " · 不收录（手动排除）" : " · 不收录"
                      }`,
                    ],
                  ]}
                />
              ) : (
                <span className="text-ink-4">没有公开投影（未通过相关性或仍在处理）</span>
              )}
              {c.override && (
                <div className="mt-3 rounded-control bg-accent-softer p-3 ring-1 ring-accent/15">
                  <div className="text-[12px] text-ink-3">人工设置 v{c.override.version} · {c.override.updated_by} · {bj(c.override.updated_at, true)}{c.override.reason ? ` · ${c.override.reason}` : ""}</div>
                  <Json value={{ visibility: c.override.visibility, ...c.override.fields }} label="覆盖字段" collapsed={false} />
                </div>
              )}
            </Step>
            <Step title="精选同步流水" meta={`${c.ledger.length} 条`} tone={c.ledger.length ? "accent" : "muted"}>
              {c.ledger.length ? (
                <ul className="space-y-1">
                  {c.ledger.map((l) => (
                    <li key={l.seq} className="flex gap-2">
                      <span className="num text-ink-4">#{l.seq}</span>
                      <Badge tone={l.op === "remove" ? "warn" : "ok"}>{l.op}</Badge>
                      <span className="num text-ink-4">可见 {bj(l.visible_at)} · 写入 {bj(l.changed_at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-ink-4">没有进入过精选同步流</span>
              )}
            </Step>
            <Step title="事件归组" tone={story ? "accent" : "muted"} meta={a.grouped_at ? `归组于 ${bj(a.grouped_at, true)}` : "未归组"}>
              {c.membership.map((m) => (
                <div key={m.fact_id} className="mb-2">
                  <div>
                    事实 <span className="font-mono text-[12px]">#{m.fact_id}</span> {m.fact_title} <Badge>{m.role}</Badge> {m.manual && <Badge tone="info">人工</Badge>}
                  </div>
                  {m.story_public_id && (
                    <div className="mt-0.5">
                      事件 <a className="text-accent" href={`/story/${m.story_public_id}`} target="_blank" rel="noreferrer">{m.story_title}</a> <span className="font-mono text-[12px] text-ink-4">#{m.story_id}</span>
                    </div>
                  )}
                </div>
              ))}
              {c.decisions.length > 0 && (
                <ul className="mt-2 space-y-1 text-[12.5px]">
                  {c.decisions.map((d, i) => (
                    <li key={i} className="flex flex-wrap gap-2">
                      <span className="num text-ink-4">{bj(d.created_at)}</span>
                      <Badge>{d.verdict}</Badge>
                      {d.fact_id && <span>事实 #{d.fact_id}</span>}
                      {d.receipt_id && <span className="text-ink-4">回执 #{d.receipt_id}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setDialog("group")}>重新归组</Button>
                {c.membership.length > 0 && <Button size="sm" onClick={() => setDialog("detach")}>移出事件</Button>}
                {story?.story_id && <Button size="sm" onClick={() => setDialog("merge")}>把这个事件并入…</Button>}
              </div>
            </Step>
            <Step title="投递" last meta={`${c.deliveries.length} 条`} tone={c.deliveries.some((d) => d.status === "unknown") ? "bad" : c.deliveries.length ? "accent" : "muted"}>
              {c.deliveries.length ? (
                <ul className="space-y-1">
                  {c.deliveries.map((d, i) => (
                    <li key={i} className="flex flex-wrap gap-2">
                      <span>{d.target_key}</span>
                      <Badge tone={d.status === "sent" ? "ok" : d.status === "unknown" ? "bad" : "muted"}>{d.status}</Badge>
                      <span className="num text-ink-4">{bj(d.created_at)}{d.sent_at ? ` → ${bj(d.sent_at)}` : ""}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-ink-4">没有推送记录</span>
              )}
            </Step>
          </ol>
        </Card>

        <div className="space-y-5">
          <Card title="原始信息">
            <KV
              items={[
                ["原标题", a.title],
                ["作者", a.author],
                ["语言", a.language],
                ["身份键", <span className="break-all font-mono text-[11.5px]">{a.identity_key}</span>],
              ]}
            />
          </Card>
          <Card title="修改记录">
            {c.history.length ? (
              <ul className="space-y-3 text-[12.5px]">
                {c.history.map((h, i) => (
                  <li key={i}>
                    <div className="text-ink-2"><span className="font-medium">{h.action}</span> · {h.actor} · {bj(h.created_at)}</div>
                    {h.reason && <div className="text-ink-3">{h.reason}</div>}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>没有人工操作</Empty>
            )}
          </Card>
        </div>
      </div>

      <ReasonDialog
        open={dialog === "seo"}
        title={p?.indexable ? "取消搜索收录" : "标记为可收录"}
        description={
          p?.indexable
            ? "详情页改回 noindex 并移出站点地图；即使是精选，也不再自动收录，直到重新标记。"
            : "详情页默认 noindex，精选内容自动收录。标记后（仅在公开状态下）改为 index、进入站点地图，并在下一次 IndexNow 提交。适合有独立价值、摘要与正文完整的内容。"
        }
        confirmLabel={p?.indexable ? "取消收录" : "标记收录"}
        busy={pending === "seo"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => (await run("POST", `${base}/seo`, { indexed: !p?.indexable, reason }, { label: "seo", success: p?.indexable ? "已取消收录" : "已标记为可收录" })) !== null}
      />

      <ReasonDialog
        open={dialog === "visibility"}
        title="公开范围"
        description="改动会同时作用于网页、API、RSS、MCP、同步流和搜索索引，并刷新缓存。来源方要求下架时，先核实身份与范围。"
        danger={visibility === "withdrawn"}
        confirmLabel="应用"
        busy={pending === "visibility"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => (await run("POST", `${base}/visibility`, { visibility, reason, version }, { label: "visibility", success: "公开范围已更新" })) !== null}
      >
        <div className="grid gap-2 sm:grid-cols-3">
          {([
            ["public", "公开", "正常展示"],
            ["summary-only", "仅摘要", "不展示正文，保留标题摘要"],
            ["withdrawn", "下架", "所有出口移除，链接 404"],
          ] as const).map(([v, label, hint]) => (
            <label key={v} className={`cursor-pointer rounded-card p-3 ring-1 transition-colors ${visibility === v ? "bg-accent-soft ring-accent" : "ring-line-strong hover:bg-bg-sunk"}`}>
              <input type="radio" name="visibility" className="sr-only" checked={visibility === v} onChange={() => setVisibility(v)} />
              <div className="text-[13.5px] font-medium text-ink">{label}</div>
              <div className="mt-0.5 text-[12px] text-ink-3">{hint}</div>
            </label>
          ))}
        </div>
      </ReasonDialog>

      <ReasonDialog
        open={dialog === "override"}
        title="人工修正"
        description="人工值优先于模型输出，之后的重处理不会覆盖；留空表示不修正该字段（清除已有修正请选“清除”）。"
        confirmLabel="保存修正"
        busy={pending === "override"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => {
          const next: Record<string, unknown> = {};
          const clear: string[] = [];
          for (const k of ["title", "summary", "reason"] as const) {
            if (fields[k].trim()) next[k] = fields[k].trim();
            else if (c.override?.fields[k] !== undefined) clear.push(k);
          }
          if (fields.category) next.category = fields.category;
          else if (c.override?.fields.category !== undefined) clear.push("category");
          if (fields.tags.trim()) next.tags = fields.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
          else if (c.override?.fields.tags !== undefined) clear.push("tags");
          for (const k of ["selected", "silent"] as const) {
            if (fields[k] === "true" || fields[k] === "false") next[k] = fields[k] === "true";
            else if (c.override?.fields[k] !== undefined) clear.push(k);
          }
          return (await run("POST", `${base}/override`, { fields: next, clear, reason, version }, { label: "override", success: "修正已保存并重新发布" })) !== null;
        }}
      >
        <Field label="标题"><Input value={fields.title} placeholder={p?.title ?? ""} onChange={(e) => setFields({ ...fields, title: e.target.value })} /></Field>
        <Field label="摘要"><Textarea rows={3} value={fields.summary} placeholder={p?.summary ?? ""} onChange={(e) => setFields({ ...fields, summary: e.target.value })} /></Field>
        <Field label="推荐理由"><Textarea rows={2} value={fields.reason} placeholder={p?.reason ?? ""} onChange={(e) => setFields({ ...fields, reason: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="栏目">
            <Select value={fields.category} onChange={(e) => setFields({ ...fields, category: e.target.value })}>
              <option value="">不修正</option>
              {CATEGORY_KEYS.map((k) => <option key={k} value={k}>{CATEGORY_LABELS[k]}</option>)}
            </Select>
          </Field>
          <Field label="标签（逗号分隔）"><Input value={fields.tags} onChange={(e) => setFields({ ...fields, tags: e.target.value })} /></Field>
          <Field label="精选">
            <Select value={fields.selected} onChange={(e) => setFields({ ...fields, selected: e.target.value })}>
              <option value="">按模型</option>
              <option value="true">强制入选</option>
              <option value="false">强制不选</option>
            </Select>
          </Field>
          <Field label="推送">
            <Select value={fields.silent} onChange={(e) => setFields({ ...fields, silent: e.target.value })}>
              <option value="">正常</option>
              <option value="true">静默（入选也不推送）</option>
              <option value="false">取消静默</option>
            </Select>
          </Field>
        </div>
      </ReasonDialog>

      <ReasonDialog
        open={dialog === "analyze"}
        title="对当前修订重新评估"
        description="会发起一次新的模型调用（计费并记录回执）。同一次提交重复点击不会重复收费。"
        requireReason={false}
        confirmLabel="重新评估"
        busy={pending === "analyze"}
        onClose={() => setDialog(null)}
        onSubmit={async () => (await run("POST", `${base}/rerun`, { step: "analyze" }, { label: "analyze", success: "已加入评估队列" })) !== null}
      />
      <ReasonDialog
        open={dialog === "extract"}
        title="重新抽取正文"
        requireReason={false}
        confirmLabel="重新抽取"
        busy={pending === "extract"}
        onClose={() => setDialog(null)}
        onSubmit={async () => (await run("POST", `${base}/rerun`, { step: "extract" }, { label: "extract", success: "已加入抽取队列" })) !== null}
      />
      <ReasonDialog
        open={dialog === "group"}
        title="重新归组"
        description="人工归组的成员关系不会被覆盖。"
        requireReason={false}
        confirmLabel="重新归组"
        busy={pending === "group"}
        onClose={() => setDialog(null)}
        onSubmit={async () => (await run("POST", `${base}/rerun`, { step: "group" }, { label: "group", success: "已加入归组队列" })) !== null}
      />
      <ReasonDialog
        open={dialog === "detach"}
        title="移出事件"
        description="这条内容会作为独立内容展示，事件页随之更新。"
        danger
        confirmLabel="移出"
        busy={pending === "detach"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => (await run("POST", `${base}/detach`, { reason }, { label: "detach", success: "已移出事件" })) !== null}
      />
      <ReasonDialog
        open={dialog === "merge"}
        title="合并事件"
        description={`把事件 #${story?.story_id}（${story?.story_title ?? ""}）并入另一个事件；旧链接会跳转到新事件。`}
        danger
        confirmLabel="合并"
        busy={pending === "merge"}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => {
          if (!/^\d+$/.test(mergeInto.trim())) return false;
          return (await run("POST", "/api/admin/stories/merge", { from: story!.story_id, into: Number(mergeInto), reason }, { label: "merge", success: "事件已合并" })) !== null;
        }}
      >
        <Field label="并入的目标事件编号" hint="在目标事件任一内容的诊断页里可以看到 #编号">
          <Input inputMode="numeric" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)} placeholder="例如 1234" />
        </Field>
      </ReasonDialog>
    </AdminPage>
  );
}
