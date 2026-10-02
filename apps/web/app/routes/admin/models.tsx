import { SITE } from "@aihot/industry/site";
import { useState } from "react";
import { Link } from "react-router";
import type { AdminModels } from "@aihot/contracts/admin";
import { MODEL_PROVIDERS, recognizeModelProvider, type ModelConnectionInput, type ModelConnectionView } from "@aihot/contracts/model-connection";
import type { Route } from "./+types/models";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, money, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Field, FilterChips, Input, ReasonDialog, Select } from "../../features/admin/ui";



export async function loader({ request }: Route.LoaderArgs) {
  const days = new URL(request.url).searchParams.get("days") ?? "7";
  return adminGet<AdminModels>(request, `/api/admin/models?days=${encodeURIComponent(days)}`);
}

export const meta: Route.MetaFunction = () => [{ title: `模型与评测 · ${SITE.name} 后台` }];

const SOURCE_LABEL = { admin: "后台切换", env: "环境变量", default: "代码默认" } as const;
const secs = (ms: number | null) => (ms == null ? "—" : ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

function ConnectionForm({ current }: { current: ModelConnectionView }) {
  const { run, busy } = useAdminAction();
  const [provider, setProvider] = useState<ModelConnectionInput["provider"]>(current.provider);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(current.baseUrl);
  const [model, setModel] = useState(current.model);
  const [extraJson, setExtraJson] = useState(current.extraJson);
  const [models, setModels] = useState<string[]>([]);
  const [hint, setHint] = useState("");
  const preset = MODEL_PROVIDERS.find((p) => p.id === provider);
  const chooseProvider = (next: ModelConnectionInput["provider"]) => {
    setProvider(next);
    const p = MODEL_PROVIDERS.find((p) => p.id === next);
    if (p?.baseUrl) setBaseUrl(p.baseUrl);
    setModel(p?.model ?? "");
    setExtraJson("");
    setModels([]);
    setHint(next === "auto" ? "请粘贴密钥。通用格式的密钥需要选择服务商；中转站请选择自定义。" : "");
  };
  const input = (): ModelConnectionInput => ({ provider, apiKey, baseUrl, model, extraJson });
  return (
    <Card title="模型 API 连接" right={<Badge>{current.source === "admin" ? "后台配置" : "现有配置"}</Badge>}>
      <p className="mb-4 text-[13px] text-ink-3">填入密钥，自动识别支持的格式并补全接口。中转站首次填一次地址，可读取模型列表。保存后约 5 秒内用于后续任务，无需重启。</p>
      <form className="grid gap-4 md:grid-cols-2" onSubmit={async (e) => {
        e.preventDefault();
        const saved = await run<ModelConnectionView>("PUT", "/api/admin/models/connection", input(), { label: "connection-save", success: "配置已保存，后续任务自动生效" });
        if (saved) { setApiKey(""); setProvider(saved.provider); setBaseUrl(saved.baseUrl); setModel(saved.model); setHint("已保存。正在处理的任务会完成，后续任务使用新配置。"); }
      }}>
        <Field label="API Key" hint={current.hasKey ? "留空保留现有密钥；更换接口地址时需要填写对应的新密钥。" : "从服务商控制台复制密钥。"}>
          <Input aria-label="API Key" type="password" autoComplete="new-password" value={apiKey} placeholder={current.hasKey ? "已配置，密钥不回显" : "粘贴 API Key"} onChange={(e) => {
            const key = e.target.value.trim();
            setApiKey(key);
            setModels([]);
            if (!key || provider === "custom") return;
            const detected = recognizeModelProvider(key);
            if (detected) {
              chooseProvider(detected);
              setHint(`识别建议：${MODEL_PROVIDERS.find((p) => p.id === detected)?.label}。如果来自中转站，请选择自定义；百炼请核对地域。`);
            } else {
              setProvider("auto");
              setHint("此密钥格式无法区分厂商，请选择服务商；如果来自中转站，请选择自定义。");
            }
          }} />
        </Field>
        <Field label="服务商">
          <Select aria-label="服务商" value={provider} onChange={(e) => chooseProvider(e.target.value as ModelConnectionInput["provider"])}>
            <option value="auto">自动识别</option>
            {MODEL_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </Field>
        {provider === "custom" ? <Field label="中转站接口地址" hint="填写平台提供的 Base URL，例如 https://example.com/v1。">
          <Input aria-label="中转站接口地址" type="url" value={baseUrl} placeholder="https://example.com/v1" required onChange={(e) => { setBaseUrl(e.target.value); setModels([]); }} />
        </Field> : <div className="text-[12px] text-ink-3 md:col-span-2">接口地址：<span className="break-all font-mono">{preset?.baseUrl || "识别或选择服务商后自动填写"}</span></div>}
        <Field label="模型名称" hint="可读取模型列表后选择；平台不提供列表时，直接填写模型名称。">
          <Input aria-label="模型名称" list="connection-models" value={model} placeholder="选择或输入模型名称" onChange={(e) => { setModel(e.target.value); setExtraJson(""); }} required />
          <datalist id="connection-models">{(models.length ? models : preset?.model ? [preset.model] : []).map((id) => <option key={id} value={id} />)}</datalist>
        </Field>
        <div className="flex items-center gap-3">
          <Button type="button" disabled={busy || provider === "auto"} onClick={async () => {
            const result = await run<{ models: string[] }>("POST", "/api/admin/models/connection/models", input(), { label: "connection-models", revalidate: false });
            if (result) { setModels(result.models); if (!result.models.includes(model)) { setModel(result.models[0] ?? ""); setExtraJson(""); } setHint(`已读取 ${result.models.length} 个模型，点击模型输入框选择。列表可读取表示密钥通过了该接口的列表鉴权；具体模型调用以任务结果为准。`); }
          }}>读取模型列表</Button>
        </div>
        <details className="md:col-span-2">
          <summary className="cursor-pointer text-[12.5px] text-ink-3">高级参数（通常自动设置即可）</summary>
          <div className="mt-3"><Field label="额外参数 JSON" hint="留空按所选模型自动设置。填 {} 可关闭自动参数。"><Input aria-label="额外参数 JSON" value={extraJson} placeholder="自动设置" onChange={(e) => setExtraJson(e.target.value)} /></Field></div>
        </details>
        {hint && <p className="text-[12.5px] text-ink-3 md:col-span-2" role="status">{hint}</p>}
        <div className="md:col-span-2"><Button type="submit" tone="primary" disabled={busy || provider === "auto"}>保存并使用</Button></div>
      </form>
    </Card>
  );
}

export default function ModelsAdmin({ loaderData: m }: Route.ComponentProps) {
  const { run, pending } = useAdminAction();
  const [target, setTarget] = useState<AdminModels["capabilities"][number] | null>(null);
  const [choice, setChoice] = useState<string>("");
  const labelOf = (key: string) => m.capabilities.find((c) => `capability:${c.key}` === key)?.label ?? key;

  return (
    <AdminPage
      title="模型与评测"
      subtitle="每项能力当前用哪个模型、来自哪里（后台切换 > 环境变量 > 代码默认），以及近期的成功率、耗时与费用。切换只影响之后的新任务，已有结果不重算；换精选模型前先看 SelectBench 同批对比。"
      actions={<FilterChips param="days" options={[{ value: "1", label: "24 小时" }, { value: "", label: "7 天" }, { value: "30", label: "30 天" }]} />}
    >
      <div className="grid gap-5">
        <ConnectionForm current={m.connection} />
        {m.capabilities.map((c) => {
          const total = c.usage.reduce((a, u) => a + u.calls, 0);
          return (
            <Card
              key={c.key}
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  {c.label}
                  <span className="font-mono text-[12px] font-normal text-ink-3">{c.current.model}</span>
                  <Badge tone={c.current.source === "admin" ? "accent" : "muted"}>{SOURCE_LABEL[c.current.source]}</Badge>
                </span>
              }
              right={
                <Button
                  size="sm"
                  onClick={() => {
                    setTarget(c);
                    setChoice(c.current.model);
                  }}
                >
                  切换
                </Button>
              }
              pad={false}
            >
              {c.usage.length ? (
                <DataTable
                  dense
                  rows={c.usage}
                  rowKey={(u) => `${u.purpose}|${u.model}|${u.promptVersion}`}
                  columns={[
                    { key: "m", label: "模型", render: (u) => <span className="whitespace-nowrap font-mono text-[12px]">{u.model}</span> },
                    { key: "v", label: "提示版本", render: (u) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{u.promptVersion ?? "—"}</span> },
                    { key: "p", label: "用途", render: (u) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{u.purpose}</span> },
                    { key: "c", label: "调用", align: "right", render: (u) => num(u.calls) },
                    {
                      key: "ok",
                      label: "成功率",
                      align: "right",
                      render: (u) => {
                        const rate = u.calls ? u.ok / u.calls : 0;
                        return <span className={rate < 0.95 ? "text-hot" : ""} title={`失败 ${u.failed} · 结果未知 ${u.unknown}`}>{`${Math.round(rate * 1000) / 10}%`}</span>;
                      },
                    },
                    { key: "l", label: "耗时 p50 / p95", align: "right", render: (u) => <span className="whitespace-nowrap">{`${secs(u.p50)} / ${secs(u.p95)}`}</span> },
                    { key: "t", label: "输入 / 输出 token", align: "right", render: (u) => <span className="whitespace-nowrap">{`${num(u.tokensIn)} / ${num(u.tokensOut)}`}</span> },
                    {
                      key: "$",
                      label: "费用",
                      align: "right",
                      render: (u) =>
                        u.actualCost !== null ? (
                          `${money(u.actualCost)}${u.currency && u.currency !== "CNY" ? ` ${u.currency}` : ""}`
                        ) : u.estimate ? (
                          <span title="按用量 × 单价推算">≈ {money(u.estimate.amount)}{u.estimate.currency !== "CNY" ? ` ${u.estimate.currency}` : ""}</span>
                        ) : (
                          <span className="whitespace-nowrap text-ink-4" title="服务商没有返回费用，按 token 数和你的模型单价自己估算">未定价</span>
                        ),
                    },
                  ]}
                />
              ) : (
                <Empty>{m.days} 天内没有调用{total === 0 && c.vision ? "（只在有图片时使用）" : ""}</Empty>
              )}
            </Card>
          );
        })}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card title="切换记录" pad={false}>
          {m.history.length ? (
            <DataTable
              dense
              rows={m.history}
              rowKey={(h) => `${h.at}|${h.subject}`}
              columns={[
                { key: "at", label: "时间", render: (h) => <span className="num whitespace-nowrap">{bj(h.at)}</span> },
                { key: "c", label: "能力", render: (h) => labelOf(h.subject) },
                { key: "m", label: "变化", render: (h) => <span className="font-mono text-[12px]">{h.before?.model ?? "—"} → {h.after?.model ?? "—"}</span> },
                { key: "r", label: "原因", render: (h) => <span className="text-ink-3">{h.reason}</span> },
                { key: "a", label: "操作人", render: (h) => h.actor },
              ]}
            />
          ) : (
            <Empty>还没有在后台切换过模型</Empty>
          )}
        </Card>
        <Card title="同批样本对比（SelectBench）" right={<Link to="/admin/selectbench" className="text-accent">全部运行</Link>} pad={false}>
          {m.benches.length ? (
            <DataTable
              dense
              rows={m.benches}
              rowKey={(b) => b.id}
              columns={[
                { key: "l", label: "运行", render: (b) => <Link to={`/admin/selectbench/${b.id}`} className="text-ink hover:text-accent">{b.label}</Link> },
                { key: "m", label: "模型", render: (b) => <span className="font-mono text-[11.5px] text-ink-3">{b.models.join("、")}</span> },
                { key: "n", label: "样本", align: "right", render: (b) => num(b.sample_size) },
                { key: "at", label: "时间", render: (b) => <span className="num whitespace-nowrap">{bj(b.created_at)}</span> },
              ]}
            />
          ) : (
            <Empty>还没有导入对比运行</Empty>
          )}
        </Card>
      </div>

      <ReasonDialog
        open={!!target}
        title={`切换模型：${target?.label ?? ""}`}
        description="只影响之后的新任务。选“恢复默认”会回到环境变量或代码默认。"
        confirmLabel="切换"
        busy={pending === "switch"}
        onClose={() => setTarget(null)}
        onSubmit={async (reason) =>
          (await run("POST", `/api/admin/models/${target!.key}`, { model: choice === "__default" ? null : choice, reason }, { label: "switch", success: "已切换，下一次调用生效" })) !== null
        }
      >
        <Field label="模型">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
            {m.choices
              .filter((x) => x.vision === !!target?.vision)
              .map((x) => (
                <option key={x.key} value={x.key}>
                  {x.key}（{x.service}）
                </option>
              ))}
            <option value="__default">恢复默认（{target?.env} 或 {target?.defaultModel}）</option>
          </Select>
        </Field>
      </ReasonDialog>
    </AdminPage>
  );
}
