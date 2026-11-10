import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { AdminSourceCreated } from "@aihot/contracts/admin";
import { useAdminAction } from "./action";
import { Button, Field, Input, Textarea } from "./ui";

interface WechatLookup {
  found: boolean;
  account: { ghid: string; name: string | null } | null;
  duplicate: { id: string; name: string } | null;
}

function sourceIdFor(ghid: string): string {
  const slug = ghid.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72).replace(/-+$/g, "");
  return `wechat-${slug || "account"}`;
}

export function ImportWechatSource() {
  const navigate = useNavigate();
  const { run, pending } = useAdminAction();
  const [open, setOpen] = useState(false);
  const [identifier, setIdentifier] = useState("");
  const [lookup, setLookup] = useState<WechatLookup | null>(null);
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (pending) return;
    setOpen(false);
    setError(null);
  };

  async function lookupAccount(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setLookup(null);
    setName("");
    setTags("");
    if (!identifier.trim()) {
      setError("请粘贴一篇公众号文章链接或输入 ghid。");
      return;
    }
    const result = await run<WechatLookup>("POST", "/api/admin/sources/wechat/lookup", { input: identifier.trim() }, { label: "wechat-lookup", revalidate: false });
    if (!result) return;
    setLookup(result);
    setName(result.account?.name ?? "");
  }

  async function createSource() {
    const account = lookup?.account;
    const ghid = account?.ghid;
    if (!lookup || !account || !ghid || !name.trim() || lookup.duplicate) return;
    const result = await run<AdminSourceCreated>("POST", "/api/admin/sources", {
      id: sourceIdFor(ghid),
      name: name.trim(),
      kind: "mp_account",
      config: { ghid, nickname: name.trim() },
      tier: "T2",
      participation_mode: "editorial",
      interval_minutes: 360,
      first_party: false,
      tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
      site_fulltext: false,
      syndicate_fulltext: false,
    }, { label: `wechat-create-${ghid}`, success: "公众号信源已添加" });
    if (!result) return;
    if (result.created) navigate(`/admin/sources/${encodeURIComponent(result.source.id)}`);
    else setLookup({ ...lookup, duplicate: result.duplicate });
  }

  return (
    <>
      <Button onClick={() => { setOpen(true); setIdentifier(""); setLookup(null); setName(""); setTags(""); setError(null); }}>导入公众号</Button>
      {open && (
        <div className="fixed inset-0 z-[75] flex items-end justify-center p-3 sm:items-center" onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
          <button type="button" aria-label="关闭导入窗口" className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]" onClick={close} />
          <section role="dialog" aria-modal="true" aria-labelledby="wechat-import-title" className="relative max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-sheet bg-raised p-5 shadow-2xl ring-1 ring-line-strong">
            <h2 id="wechat-import-title" className="text-[16px] font-semibold text-ink">导入微信公众号信源</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">粘贴一篇公众号文章链接，或输入以 gh_ 开头的公众号原始 ID。系统从文章源码提取 ghid 和可识别的名称，不调用 wxrank 账号资料接口。</p>
            <form onSubmit={lookupAccount} className="mt-4 space-y-3">
              <Field label="文章链接或公众号 ghid">
                <Textarea rows={2} value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="https://mp.weixin.qq.com/s/... 或 gh_1234567890" />
              </Field>
              <p className="text-[12px] text-ink-4">直接输入 ghid 时，文章名称需手动填写。</p>
              {error && <p role="alert" className="text-[12.5px] text-hot">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button tone="ghost" onClick={close}>取消</Button>
                <Button type="submit" tone="primary" busy={pending === "wechat-lookup"} disabled={!identifier.trim()}>解析公众号</Button>
              </div>
            </form>

            {lookup && (
              <div className="mt-4 rounded-card bg-bg-sunk/70 p-4 ring-1 ring-line">
                {!lookup.found || !lookup.account ? (
                  <p className="text-[13px] text-ink-2">没有从文章源码识别出公众号 ghid。可直接输入以 gh_ 开头的原始 ID。</p>
                ) : (
                  <>
                    <div className="grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[110px_1fr]">
                      <span className="text-ink-4">原始 ID（ghid）</span><span className="break-all font-mono text-ink-2">{lookup.account.ghid}</span>
                    </div>
                    {lookup.duplicate ? (
                      <p className="mt-4 text-[13px] text-amber-ink">这个公众号已经添加：<Link className="font-medium text-accent" to={`/admin/sources/${encodeURIComponent(lookup.duplicate.id)}`} onClick={close}>{lookup.duplicate.name}（{lookup.duplicate.id}）</Link>。没有新建。</p>
                    ) : (
                      <>
                        <div className="mt-4">
                          <Field label="公众号名称（必填）">
                            <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} placeholder="填写公众号名称" />
                          </Field>
                        </div>
                        <div className="mt-3">
                          <Field label="信源标签（可选，逗号分隔）">
                            <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="自行填写标签" />
                          </Field>
                        </div>
                        <div className="mt-4 flex justify-end">
                          <Button tone="primary" busy={pending === `wechat-create-${lookup.account.ghid}`} disabled={!name.trim()} onClick={createSource}>确认并添加信源</Button>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
