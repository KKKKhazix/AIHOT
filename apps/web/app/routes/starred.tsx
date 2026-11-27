import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { ItemAvailability } from "@aihot/contracts/site";
import { shortAddresses } from "@aihot/contracts/addresses";
import { SITE } from "@aihot/site";
import type { Route } from "./+types/starred";
import { Collapse } from "../components/ui/Presence";
import { edgeTtl } from "../lib/api.server";
import { useHydrated } from "../lib/hydration";
import { pageMeta } from "../lib/seo";
import type { StarredItem } from "@aihot/contracts/sync";
import { exportBundle, importBundle, ImportError, removeStar, restoreStar, useStarred, type ImportReport } from "../lib/local-state";
import { fullDateTime } from "../lib/format";
import { IconBookmark, IconDownload, IconClose } from "../components/icons";
import { readSnapshot, restoreAnchor, useSaveOnLeave } from "../lib/restore";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";
import { webModules } from "../site-modules";
import { Link } from "../lib/link";
import { apiIn, L, localeOf, translator, useLocale, useT, type Text, type Translate } from "../lib/i18n";

export const handle: Screen = { tab: "me", name: L("收藏", "Saved") };

export function headers() {
  return edgeTtl(300);
}

export function meta({ location }: Route.MetaArgs) {
  const locale = localeOf(location.pathname);
  const t = translator(locale);
  return pageMeta({ locale, title: t("我的收藏", "Saved"), description: t(`收藏的 ${SITE.name} 内容，适合稍后阅读和回看。`, `What you've saved on ${SITE.name}, to read later or come back to.`), path: "/starred", noindex: true });
}

const BACK = { to: "/more", label: L("我的", "Me") };
const items = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

function reportText(r: ImportReport, t: Translate): string {
  const parts = [t(`新增收藏 ${r.starredAdded} 条`, `${items(r.starredAdded)} saved`), t(`已读记录 ${r.readAdded} 条`, `${items(r.readAdded)} marked read`)];
  if (r.starredSkipped || r.readSkipped) parts.push(t(`有 ${r.starredSkipped + r.readSkipped} 条没导入（超出数量上限或格式不对）`, `${items(r.starredSkipped + r.readSkipped)} not imported (over the limit or in the wrong format)`));
  if (r.themeApplied) parts.push(t("已沿用导入的深浅色设置", "appearance setting applied"));
  if (r.fontApplied) parts.push(t("已沿用导入的字体设置", "font setting applied"));
  if (r.readFailed) parts.push(t("已读记录没能保存（浏览器存储已满或不可用）", "read history couldn't be saved (browser storage is full or unavailable)"));
  return parts.join(t("，", ", "));
}

export default function StarredPage() {
  const t = useT();
  const locale = useLocale();
  const starred = useStarred();
  const mounted = useHydrated();
  const [availability, setAvailability] = useState<Record<string, ItemAvailability>>({});
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // A row taken out here stays where it was, faded, for as long as the reader is on this page: pressing its
  // bookmark again puts it back as it was. It is gone the next time the page opens.
  const [removed, setRemoved] = useState<Array<{ item: StarredItem; index: number }>>([]);
  const rows = useMemo(() => {
    const list = starred.map((item) => ({ item, on: true }));
    for (const r of [...removed].sort((a, b) => a.index - b.index)) {
      if (!starred.some((s) => s.id === r.item.id)) list.splice(Math.min(r.index, list.length), 0, { item: r.item, on: false });
    }
    return list;
  }, [starred, removed]);
  const unstar = (item: StarredItem, index: number) => {
    setRemoved((rs) => [...rs.filter((r) => r.item.id !== item.id), { item, index }]);
    removeStar(item.id);
  };
  // Put back, its bookmark bumps as it does on a card.
  const [bumped, setBumped] = useState<Record<string, number>>({});
  const restar = (item: StarredItem) => {
    if (restoreStar(item)) {
      setRemoved((rs) => rs.filter((r) => r.item.id !== item.id));
      setBumped((b) => ({ ...b, [item.id]: (b[item.id] ?? 0) + 1 }));
    }
    else setNotice({ kind: "error", text: t("没能放回收藏：收藏已满 500 条，或浏览器存储不可用。", "Couldn't put it back: Saved is full (500 items), or browser storage isn't available.") });
  };

  const starredIds = starred.map((s) => s.id).join(",");
  useEffect(() => {
    if (!mounted || !starredIds) return;
    const controller = new AbortController();
    // Batches of 100: a request line with all 500 ids is longer than the front servers accept.
    const ids = starredIds.split(",");
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += 100) batches.push(ids.slice(i, i + 100));
    Promise.all(
      batches.map((batch) =>
        fetch(apiIn(`/items/availability?ids=${encodeURIComponent(batch.join(","))}`, locale), { signal: controller.signal })
          .then((r) => (r.ok ? (r.json() as Promise<Record<string, ItemAvailability>>) : {}))
          .catch(() => ({})),
      ),
    ).then((parts) => {
      if (!controller.signal.aborted) setAvailability(Object.assign({}, ...parts));
    });
    return () => controller.abort();
  }, [mounted, starredIds, locale]);

  // Back from an item: the list renders only after mounting (it lives in this browser), so the
  // position comes back once it is there, by the same card anchor the other lists use.
  const historyKey = useLocation().key;
  useLayoutEffect(() => {
    if (!mounted || starred.length === 0) return;
    const snap = readSnapshot<null>(historyKey);
    if (snap) restoreAnchor(snap.anchor, snap.scrollY);
  }, [mounted, historyKey]);
  useSaveOnLeave(historyKey, () => null);

  const doExport = () => {
    const blob = new Blob([JSON.stringify(exportBundle(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${SITE.mcpPrefix}-local-data-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const doImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const report = importBundle(await file.text());
      setNotice({ kind: report.readFailed ? "error" : "ok", text: t(`导入完成：${reportText(report, t)}`, `Import complete: ${reportText(report, t)}.`) });
    } catch (e) {
      setNotice({ kind: "error", text: e instanceof ImportError ? t(e.reason) : t(e instanceof Error ? e.message : "导入失败", "Import failed.") });
    }
  };

  // Imports from elsewhere that the site's modules offer.
  const importFrom = (run: () => Promise<{ ok: boolean; text: Text }>) =>
    run().then(
      (r) => setNotice({ kind: r.ok ? "ok" : "error", text: t(r.text) }),
      (err: Error) => setNotice({ kind: "error", text: err.message }),
    );
  // A module's import named in Chinese only (its site was Chinese only) stays off English pages.
  const imports = webModules().flatMap((m) => m.starredImports ?? []).filter((i) => locale === "zh" || typeof i.label !== "string");

  const action = "inline-flex min-h-11 items-center text-ui-caption-lg text-ink-3 transition-colors hover:text-accent lg:min-h-0 touch:min-h-11";
  const Account = webModules().find((m) => m.account)?.account;
  const localNote = <p className="rounded-tile border border-line bg-surface px-4 py-2.5 text-ui-caption-lg text-ink-3">{t("不用登录，收藏直接存在这个浏览器里；清除浏览器数据或换设备都不会同步，换设备前可以先导出备份。", "No sign-in needed: saved items are kept in this browser. They don't carry over if you clear browser data or switch devices, so export a backup before you switch.")}</p>;
  return (
    <div className="pb-12">
      <PhoneBar back={BACK} title={t("收藏", "Saved")} />
      <header className="flex flex-col gap-2 pb-4 pt-3 sm:flex-row sm:items-start sm:justify-between lg:pt-1">
        <div>
          <h1 data-page-title="" className="text-ui-heading-lg font-semibold leading-[1.3] text-ink">{t("收藏", "Saved")}</h1>
          <p className="mt-1.5 text-ui-label text-ink-3">{t(`收藏的 ${SITE.name} 内容，适合稍后阅读和回看。`, `What you've saved on ${SITE.name}, to read later or come back to.`)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:pt-1.5">
          {imports.map((i) => (
            <button key={t(i.label)} type="button" onClick={() => importFrom(i.run)} className={action}>
              {t(i.label)}
            </button>
          ))}
          <button type="button" onClick={() => fileRef.current?.click()} className={action}>
            {t("导入文件", "Import file")}
          </button>
          {mounted && starred.length > 0 && (
            <button type="button" onClick={doExport} className={`${action} inline-flex items-center gap-1`}>
              {t(<><IconDownload size={13} /> 导出</>, <><IconDownload size={13} /> Export</>)}
            </button>
          )}
          <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { void doImport(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
      </header>
      {Account ? <Account place="starred" /> : localNote}
      {/* The gap above is padding inside the block, so it opens and closes with the notice. */}
      <Collapse open={!!notice}>
        <div className="pt-3">
          <div
            role="status"
            className={`flex items-start justify-between gap-3 rounded-tile px-4 py-2.5 text-ui-label ${notice?.kind === "ok" ? "bg-accent-soft text-accent-ink dark:text-accent" : "bg-hot-soft text-hot"}`}
          >
            {notice?.text}
            <button type="button" aria-label={t("关闭", "Close")} onClick={() => setNotice(null)} className="relative shrink-0 opacity-70 transition-opacity before:absolute before:-inset-[15px] before:content-[''] hover:opacity-100">
              <IconClose size={14} />
            </button>
          </div>
        </div>
      </Collapse>
      {!mounted ? null : rows.length === 0 ? (
        <div className="mt-3 flex flex-col items-center rounded-card border border-dashed border-line-strong px-6 py-12 text-center">
          <IconBookmark size={20} className="text-ink-4" />
          <p className="mt-3 text-ui-label text-ink-3">{t("还没有收藏。点卡片或文章里的书签，就能收进来。", "Nothing saved yet. Select the bookmark on any story to save it here.")}</p>
          <Link to="/" className="mt-4 text-ui-caption-lg font-medium text-accent hover:text-accent-ink">
            {t("去看精选 →", "See Top Picks →")}
          </Link>
        </div>
      ) : (
        <ul className="mt-3 lg:space-y-3">
          {rows.map(({ item: s, on }, index) => {
            const current = availability[s.id];
            const status = current?.status;
            const unavailable = status === "unavailable";
            // A local snapshot keeps the wording of the language it was saved in.
            const title = current?.title ?? s.title;
            const summary = current?.title !== undefined ? current.summary ?? null : s.summary;
            return (
              <li key={s.id} data-card-key={s.id} className={`relative border-b border-line-soft py-4 transition-opacity lg:card lg:px-[18px] lg:py-[15px] ${!on ? "opacity-50" : unavailable ? "opacity-70" : "lg:card-hover"}`}>
                <div className="flex items-center gap-2 text-ui-caption-lg text-ink-4">
                  <span className="min-w-0 truncate text-ink-3">{current?.sourceName ?? s.sourceName}</span>
                  {s.publishedAt && <span className="num shrink-0">· {fullDateTime(s.publishedAt)}</span>}
                  <span className="ml-auto hidden shrink-0 sm:inline">
                    {t(<>收藏于 <span className="num">{fullDateTime(s.savedAt)}</span></>, <>Saved <span className="num">{fullDateTime(s.savedAt)}</span></>)}
                  </span>
                  {/* The same bookmark as on every card: pressed again, it saves the item back. */}
                  <button
                    type="button"
                    aria-pressed={on}
                    aria-label={on ? t("取消收藏", "Remove from Saved") : t("收藏", "Save")}
                    title={on ? t("取消收藏", "Remove from Saved") : t("收藏", "Save")}
                    onClick={() => (on ? unstar(s, index) : restar(s))}
                    className={`relative z-10 -my-[11px] -mr-3 ml-auto grid size-11 shrink-0 place-items-center rounded-control press sm:ml-0 lg:-my-1 lg:mr-0 lg:size-[26px] lg:touch:before:absolute lg:touch:before:-inset-[9px] lg:touch:before:content-[''] ${on ? "text-accent" : "text-ink-4 hover:bg-bg-sunk hover:text-ink-2"}`}
                  >
                    <span key={bumped[s.id] ?? 0} className={`flex ${bumped[s.id] ? "anim-bump" : ""}`}>
                      <IconBookmark size={16} filled={on} />
                    </span>
                  </button>
                </div>
                <h2 className="mt-1.5 text-ui-body-lg font-[650] leading-[1.55] text-ink">
                  {unavailable ? (
                    title
                  ) : (
                    <Link viewTransition to={`/items/${s.id}`} className="transition-colors after:absolute after:inset-0 after:content-[''] hover:text-accent">
                      {title}
                    </Link>
                  )}
                </h2>
                {summary && <p className="mt-1.5 line-clamp-2 text-ui-body-sm leading-[1.75] text-ink-3">{shortAddresses(summary)}</p>}
                {unavailable && <p className="mt-2 text-ui-caption-lg text-hot">{t("这条内容已经下架，收藏会一直保留，直到你手动移除。", "This story has been taken down. It stays in Saved until you remove it.")}</p>}
                {status === "summary-only" && <p className="mt-2 text-ui-caption-lg text-amber-ink">{t("这条内容现在只提供摘要。", "Only the summary of this story is available now.")}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
