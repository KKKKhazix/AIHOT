import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { AdminSourceCreated } from "@aihot/contracts/admin";
import { useAdminAction } from "./action";
import { Button, Field, Input, Textarea } from "./ui";

interface WechatLookup {
  found: boolean;
  account: {
    biz: string;
    ghid: string | null;
    name: string | null;
    type: string | null;
    accountType: string | null;
    description: string | null;
    tags: string[];
  } | null;
  duplicate: { id: string; name: string } | null;
  receiptId: number;
  reused: boolean;
}

function sourceIdFor(ghid: string): string {
  const slug = ghid.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72).replace(/-+$/g, "");
  return `wechat-${slug || "account"}`;
}

export function ImportWechatSource() {
  const navigate = useNavigate();
  const { run, pending } = useAdminAction();
  const [open, setOpen] = useState(false);
  const [articleUrl, setArticleUrl] = useState("");
  const [lookup, setLookup] = useState<WechatLookup | null>(null);
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
    if (!articleUrl.trim()) {
      setError("请粘贴一篇公众号文章链接。");
      return;
    }
    const result = await run<WechatLookup>("POST", "/api/admin/sources/wechat/lookup", { articleUrl: articleUrl.trim() }, { label: "wechat-lookup", revalidate: false });
    if (!result) return;
    setLookup(result);
    setTags(result.account?.tags.join("，") ?? "");
  }

  async function createSource() {
    const account = lookup?.account;
    const ghid = account?.ghid;
    const name = account?.name;
    if (!lookup || !account || !ghid || !name || lookup.duplicate) return;
    const result = await run<AdminSourceCreated>("POST", "/api/admin/sources", {
      id: sourceIdFor(ghid),
      name,
      kind: "mp_account",
      config: { ghid, nickname: name },
      tier: "T2",
      participation_mode: "editorial",
      interval_minutes: 30,
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
      <Button onClick={() => { setOpen(true); setArticleUrl(""); setLookup(null); setTags(""); setError(null); }}>导入公众号</Button>
      {open && (
        <div className="fixed inset-0 z-[75] flex items-end justify-center p-3 sm:items-center" onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
          <button type="button" aria-label="关闭导入窗口" className="absolute inset-0 bg-ink/30 backdrop-blur-[2px]" onClick={close} />
          <section role="dialog" aria-modal="true" aria-labelledby="wechat-import-title" className="relative max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-sheet bg-raised p-5 shadow-2xl ring-1 ring-line-strong">
            <h2 id="wechat-import-title" className="text-[16px] font-semibold text-ink">导入微信公众号信源</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">粘贴一篇公众号文章链接。系统会用链接中的 Biz 查询 wxrank 资料，并检查该公众号是否已添加。</p>
            <form onSubmit={lookupAccount} className="mt-4 space-y-3">
              <Field label="公众号文章链接">
                <Textarea rows={2} value={articleUrl} onChange={(event) => setArticleUrl(event.target.value)} placeholder="https://mp.weixin.qq.com/s/..." />
              </Field>
              <p className="text-[12px] text-amber-ink">wxrank 每次查询收费 ¥0.05；未收录的查询也会收费。相同 Biz 当天重复查询会复用结果。</p>
              {error && <p role="alert" className="text-[12.5px] text-hot">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button tone="ghost" onClick={close}>取消</Button>
                <Button type="submit" tone="primary" busy={pending === "wechat-lookup"} disabled={!articleUrl.trim()}>查询公众号</Button>
              </div>
            </form>

            {lookup && (
              <div className="mt-4 rounded-card bg-bg-sunk/70 p-4 ring-1 ring-line">
                {!lookup.found || !lookup.account ? (
                  <p className="text-[13px] text-ink-2">wxrank 资源库暂未收录这个 Biz。没有创建信源。</p>
                ) : (
                  <>
                    <div className="grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[110px_1fr]">
                      <span className="text-ink-4">公众号名称</span><strong className="font-medium text-ink">{lookup.account.name ?? "未提供"}</strong>
                      <span className="text-ink-4">Biz</span><span className="break-all font-mono text-ink-2">{lookup.account.biz}</span>
                      <span className="text-ink-4">原始 ID（ghid）</span><span className="break-all font-mono text-ink-2">{lookup.account.ghid ?? "未提供"}</span>
                      <span className="text-ink-4">账号类型</span><span className="text-ink-2">{[lookup.account.type, lookup.account.accountType].filter(Boolean).join(" · ") || "未提供"}</span>
                      {lookup.account.description && <><span className="text-ink-4">简介</span><span className="text-ink-2">{lookup.account.description}</span></>}
                    </div>
                    {lookup.duplicate ? (
                      <p className="mt-4 text-[13px] text-amber-ink">这个公众号已经添加：<Link className="font-medium text-accent" to={`/admin/sources/${encodeURIComponent(lookup.duplicate.id)}`} onClick={close}>{lookup.duplicate.name}（{lookup.duplicate.id}）</Link>。没有新建。</p>
                    ) : lookup.account.ghid && lookup.account.name ? (
                      <>
                        <div className="mt-4">
                          <Field label="信源标签（可编辑，逗号分隔）">
                            <Input value={tags} onChange={(event) => setTags(event.target.value)} />
                          </Field>
                          <p className="mt-1 text-[11.5px] text-ink-4">默认填入 wxrank 提供的标签；确认后写入信源。</p>
                        </div>
                        <div className="mt-4 flex justify-end">
                          <Button tone="primary" busy={pending === `wechat-create-${lookup.account.ghid}`} onClick={createSource}>确认并添加信源</Button>
                        </div>
                      </>
                    ) : (
                      <p className="mt-4 text-[13px] text-hot">资料缺少公众号名称或 ghid，暂时无法创建信源。</p>
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
