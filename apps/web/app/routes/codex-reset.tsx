import { useEffect, useState } from "react";
import { useLoaderData, useRevalidator } from "react-router";
import { CODEX_RESET_SCAN_MINUTES, type CodexResetEvent, type CodexResetSitePage, type CodexResetDay, type CodexResetVersion } from "@aihot/contracts/monitor";
import { SITE } from "@aihot/industry/site";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { PostCard } from "../features/monitor/PostCard";
import { ResetCalendar } from "../features/monitor/ResetCalendar";
import { bjDate, bjTime, dayWord, durationText, stamp, typeName, windowText } from "../features/monitor/format";
import { monthDay } from "../lib/format";
import { IconChevronDown, IconChevronRight } from "../components/icons";
import { useEntrance } from "../lib/hydration";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "me", name: "Tibo 监控" };

export async function loader({ request, params }: { request: Request; params: { date?: string } }) {
  const [data, day] = await Promise.all([
    loadOr404<CodexResetSitePage>("/api/site/codex-reset", { signal: request.signal }),
    params.date ? loadOr404<CodexResetDay>(`/api/site/codex-reset/days/${encodeURIComponent(params.date)}`, { signal: request.signal }) : null,
  ]);
  return { ...data, ...(day ? { selectedDate: day.date, events: day.events } : {}), serverNow: Date.now() };
}

export function meta() {
  return pageMeta({
    title: "Tibo重置监控",
    description: "跟踪 Tibo 公布的 Codex 额度重置与重置卡发放：推算的北京时间生效窗口、适用范围、中文原帖与历史日历。",
    path: "/codex-reset",
    image: "/og/pages/codex-reset.png",
  });
}

export function headers() {
  return edgeTtl(30);
}

const POLL_MS = 60_000;

/**
 * Low-frequency version check while the page is in the foreground. A new version (events, statuses,
 * the outage and its recovery) or a new day reloads the page data; a newer check alone only moves the
 * "最近检查" time, without reading everything again.
 */
function useVersionPolling(version: string, today: string, onChecked: (checkedAt: string | null) => void) {
  const revalidator = useRevalidator();
  useEffect(() => {
    let stopped = false;
    let request: AbortController | null = null;
    const tick = async () => {
      if (document.visibilityState !== "visible" || request) return;
      request = new AbortController();
      try {
        const res = await fetch("/api/site/codex-reset/version", { cache: "no-store", signal: request.signal });
        if (!res.ok) return;
        const v = (await res.json()) as CodexResetVersion;
        if (stopped) return;
        if (v.version !== version || v.today !== today) revalidator.revalidate();
        else onChecked(v.checkedAt);
      } catch {
        // offline: try again next tick
      } finally {
        request = null;
      }
    };
    const timer = setInterval(tick, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      request?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [version, today, revalidator]);
}

function scopeText(e: CodexResetEvent) {
  const who = e.presentation?.audienceZh ?? e.presentation?.scopeLabel ?? "Tibo 未说明适用范围";
  return e.presentation?.productsZh ? `${who} · ${e.presentation.productsZh}` : who;
}

/** The status card: what Tibo announced and when it should land, beside his post. */
function Hero({ d, now }: { d: CodexResetSitePage; now: number }) {
  const e = d.current;
  const entrance = useEntrance();
  const shell = "cr-wash grid items-center gap-5 rounded-sheet border border-line-strong p-4 sm:p-6 lg:grid-cols-2 lg:gap-8 lg:p-8";
  if (!e) {
    const last = d.lastLanded;
    const lastDate = last?.occurredOn ? `${monthDay(last.occurredOn)}到账`
      : last?.confirmedAt ? `${monthDay(bjDate(last.confirmedAt))}确认` : "到账日期未确定";
    return (
      <section className={shell} style={{ "--tone": last ? "var(--ok-ink)" : "var(--ink-4)" } as React.CSSProperties}>
        <div className="min-w-0">
          <p className={`inline-flex items-center gap-2 text-[13px] font-medium ${last ? "text-ok-ink" : "text-ink-4"}`}>
            <span className="cr-dot" aria-hidden="true" />
            当前没有等待生效的重置
          </p>
          <h2 className="mt-3 text-[20px] font-[650] leading-[1.25] text-ink sm:text-[24px]">
            {last?.status === "confirmed"
              ? `上一次${last.type === "reset_credit" ? "重置卡发放" : "额度重置"}：${lastDate}`
              : last?.title ?? "暂无重置记录"}
          </h2>
          <p className="mt-2 text-[13px] leading-[1.75] text-ink-4">
            {last?.confirmedAt && !last.occurredOn && "确认帖日期不代表精确到账时间。"}
            {last?.confirmationBasis === "receipt_review"
              ? "已通过账户核验。尚未收录 Tibo 对本轮的完成确认，实际到账时间以账户显示为准。"
              : "不预测尚未宣布的下一次重置。Tibo 一旦宣布，这里会显示预计生效时间与原帖。"}
          </p>
          {d.outage && (
            <p className="mt-4 border-t border-line pt-4 text-[13px] leading-[1.75] text-ink-3">
              线索：{dayWord(bjDate(d.outage.publishedAt!), d.today)} {bjTime(d.outage.publishedAt!)} Tibo 确认 Codex 故障
              {d.outage.recoveredAt ? `，${bjTime(d.outage.recoveredAt)} 恢复` : ""}。故障不等于重置。
            </p>
          )}
        </div>
        {last?.posts[0] && (
          <div className="min-w-0">
            <PostCard
              avatar={d.authorAvatar}
              stage={`${last.posts[0].stage}原帖`}
              post={{ id: last.posts[0].id, publishedAt: last.posts[0].publishedAt, translation: last.posts[0].fullText ?? last.posts[0].text, original: last.posts[0].fullOriginalText ?? last.posts[0].originalText, context: last.posts[0].context, url: last.posts[0].url }}
            />
          </div>
        )}
      </section>
    );
  }
  const status = e.presentation?.status ?? "announced";
  const window = e.estimate ?? e.schedule;
  const through = window?.through ? Date.parse(window.through) : null;
  const from = window?.from ? Date.parse(window.from) : null;
  const credit = e.type === "reset_credit";
  const headline = status === "in_progress" ? (credit ? "重置卡正在发放" : "额度重置正在进行") : credit ? "等待重置卡到账" : "等待额度重置生效";
  let timing: string | null = null;
  if (status === "expired_unconfirmed" && through) timing = `已比预计晚 ${durationText(now - through)}，仍在等待确认`;
  else if (status === "announced" && from && now < from) timing = `距预计时段还有 ${durationText(from - now)}`;
  else if (status === "announced" && through && now < through) timing = "正处在预计时间段内";
  else if (status === "in_progress" && e.presentation?.reportedAt) timing = `Tibo ${stamp(e.presentation.reportedAt)} 表示正在进行`;
  const outage = d.outage && d.outage.resetEventId === e.id ? d.outage : null;
  const post = e.posts[0];
  return (
    <section
      className={`${shell} ${entrance ? "animate-fade-up" : ""}`}
      style={{ "--tone": status === "expired_unconfirmed" ? "var(--hot)" : "var(--amber-ink)" } as React.CSSProperties}
    >
      <div className="min-w-0">
        <p className={`inline-flex items-center gap-2 text-[13px] font-medium ${status === "expired_unconfirmed" ? "text-hot" : "text-amber-ink"}`}>
          <span className="cr-dot cr-dot-live" aria-hidden="true" />
          {typeName(e.type)} · Tibo 已宣布
        </p>
        <h2 className="mt-3 text-[20px] font-[650] leading-[1.25] text-ink sm:text-[24px]">{headline}</h2>
        {window?.from && (
          <p className="num mt-4 text-[24px] font-[650] leading-[1.3] tracking-[-0.01em] text-amber-ink lg:text-[clamp(24px,2.6vw,32px)]">
            预计 {windowText(window.from, window.through, d.today).replace("–", " – ")}
          </p>
        )}
        {(timing || e.estimate?.reason) && (
          <p className="mt-2 text-[13px] leading-[1.75] text-ink-4">
            {timing}
            {timing && e.estimate?.reason ? " · " : ""}
            {e.estimate?.reason}
          </p>
        )}
        <ul className="mt-4 grid gap-2 border-t border-line pt-4 text-[13px] leading-[1.75] text-ink-3">
          <li>适用范围：{scopeText(e)}</li>
          {outage?.publishedAt && (
            <li>
              起因：{dayWord(bjDate(outage.publishedAt), d.today)} {bjTime(outage.publishedAt)} Tibo 确认 Codex 故障{outage.recoveredAt ? `，${bjTime(outage.recoveredAt)} 恢复` : ""}
            </li>
          )}
        </ul>
        <p className="mt-4 text-[13px] leading-[1.75] text-ink-3">
          {credit ? "重置卡到账后由你自己决定何时使用。卡片余额以 Codex 内显示为准。" : "剩余额度可以放心用，生效后会恢复满额。以你 Codex 里显示的用量为准。"}
        </p>
      </div>
      {post && (
        <div className="min-w-0">
          <PostCard
            avatar={d.authorAvatar}
            stage={`${post.stage}原帖`}
            post={{ id: post.id, publishedAt: post.publishedAt, translation: post.fullText ?? post.text, original: post.fullOriginalText ?? post.originalText, context: post.context, url: post.url }}
          />
        </div>
      )}
    </section>
  );
}

/** The rhythm over the last 90 days: resets, credits, the median gap, the last reset. */
function Stats({ stats }: { stats: CodexResetSitePage["stats"] }) {
  const items = [
    { label: "近 90 天额度重置", value: `${stats.resets90} 次` },
    { label: "近 90 天发重置卡", value: `${stats.credits90} 次` },
    { label: "重置间隔中位数", value: stats.medianIntervalDays === null ? "—" : `${stats.medianIntervalDays} 天` },
    { label: "上次额度重置", value: stats.lastResetDate ? monthDay(stats.lastResetDate) : "—" },
  ];
  return (
    <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line sm:grid-cols-4">
      {items.map((i) => (
        <div key={i.label} className="bg-surface px-4 py-3">
          <dt className="text-[12px] text-ink-4">{i.label}</dt>
          <dd className="num mt-1 text-[18px] font-semibold text-ink">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Tibo's usual hours: 16:30–21:30 Pacific, i.e. 07:30–12:30 Beijing the next morning. */
const USUAL_FROM = 7 * 60 + 30;
const USUAL_TO = 12 * 60 + 30;
const inUsual = (m: number) => m >= USUAL_FROM && m <= USUAL_TO;

const MONITOR_WORDS = { healthy: "监控正常", delayed: "检查有延迟", attention: "监控需要处理", unknown: "监控状态未知" } as const;
const MONITOR_DOT = { healthy: "bg-ok-ink", delayed: "bg-amber-ink", attention: "bg-amber-ink", unknown: "bg-ink-4" } as const;

export default function CodexResetPage() {
  const d = useLoaderData<typeof loader>();
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  useEffect(() => setCheckedAt(null), [d.version, d.monitor?.lastVerifiedAt]);
  useVersionPolling(d.version, d.today, setCheckedAt);
  const m = d.monitor ? { ...d.monitor, lastVerifiedAt: checkedAt ?? d.monitor.lastVerifiedAt } : null;
  return (
    <div className="pb-8">
      <PhoneBar back={{ to: "/more", label: "我的" }} title="Tibo重置监控" />
      <header className="flex flex-col gap-1 pb-4 pt-3 lg:flex-row lg:items-end lg:justify-between lg:pt-1">
        <div>
          <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">Tibo重置监控</h1>
          <p className="mt-1.5 text-[13px] text-ink-3">Codex 额度重置与重置卡发放：什么时候生效、给谁、Tibo 原话</p>
        </div>
        <p className="text-[12px] text-ink-4">全部为北京时间 · UTC+8</p>
      </header>

      <LiveMonitor d={d} />

      <details className="disclosure group mt-8 border-t border-line">
        <summary className="flex items-center justify-between gap-3 py-[18px] text-[13px] text-ink-3 transition-colors hover:text-ink">
          <span className="inline-flex items-center gap-1.5">
            <IconChevronRight size={13} className="text-ink-4 transition-transform duration-200 group-open:rotate-90" />
            时间是怎么推算的？
          </span>
          <span className="text-[12px] text-ink-4">来源与规则</span>
        </summary>
        <div className="grid grid-cols-1 gap-x-8 gap-y-[18px] pb-6 pt-1.5 text-[12px] leading-[1.9] text-ink-4 md:grid-cols-2">
          <p><strong className="font-semibold text-ink-3">有原话就按原话。</strong>Tibo 写了时间（如 “6pm PST”“next hour”“end of day”），按太平洋时间换算成北京时间，并多留一两个小时——他的确认帖通常比说的时间晚一点。只写了日期的，按他以往的习惯落在当天太平洋时间傍晚。</p>
          <p><strong className="font-semibold text-ink-3">没写时间就按习惯。</strong>Tibo 多在太平洋时间 16:30–21:30 按下重置按钮，也就是北京时间第二天早上 07:30–12:30。{d.confirmMinutes.length ? `近 ${d.confirmMinutes.length} 次确认中有 ${d.confirmMinutes.filter(inUsual).length} 次在这个时段。` : ""}推算只是参考，以 Tibo 的确认和你 Codex 里的用量为准。</p>
          <p><strong className="font-semibold text-ink-3">已生效、应已生效、等待中。</strong>Tibo 发帖确认或经账户到账核实后，标为“已生效”，并注明确认依据；确认帖日期不代表精确到账时间。预计时间过去几个小时仍没有确认，显示“应已生效”，不等于已确认。重置卡与额度重置分开记录，发卡不代表额度已恢复。</p>
          <p><strong className="font-semibold text-ink-3">持续跟踪 Tibo 的公开帖子。</strong>每 {CODEX_RESET_SCAN_MINUTES} 分钟检查一次。只有明确的重置或发卡消息才会推送飞书群。个人额度和重置卡余额请在 Codex 内查看。</p>
        </div>
      </details>

      <footer className="flex flex-col gap-2 border-t border-line py-4 text-[12px] text-ink-4 sm:flex-row sm:items-start sm:justify-between">
        {m ? (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
              <span className={`size-1.5 rounded-full ${MONITOR_DOT[m.status]}`} />
              {MONITOR_WORDS[m.status]} · 最近检查 <span className="num">{stamp(m.lastVerifiedAt)}</span>
              <IconChevronDown size={13} className="text-ink-4 transition-transform group-open:rotate-180" />
            </summary>
            <dl className="num mt-2 grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 pl-4 text-[12px] text-ink-4">
              <dt>最近尝试</dt><dd>{stamp(m.lastAttemptAt)}</dd>
              <dt>最近采集</dt><dd>{stamp(m.lastCollectedAt)}</dd>
              <dt>最近完整核验</dt><dd>{stamp(m.lastVerifiedAt)}</dd>
              {m.pendingCount > 0 && <><dt>待处理帖子</dt><dd>{m.pendingCount}</dd></>}
              {m.heldWindowCount > 0 && <><dt>待核实窗口</dt><dd>{m.heldWindowCount}</dd></>}
            </dl>
          </details>
        ) : (
          <span>监控状态暂不可用</span>
        )}
        <span>{SITE.name} 整理 · 非 OpenAI 官方页面</span>
      </footer>
    </div>
  );
}

/** Only the changing status/calendar need the foreground clock; archive statistics stay still. */
function LiveMonitor({ d }: { d: CodexResetSitePage & { serverNow: number } }) {
  const [now, setNow] = useState(d.serverNow);
  useEffect(() => {
    const update = () => { if (document.visibilityState === "visible") setNow(Date.now()); };
    update();
    const t = setInterval(update, 30_000);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", update);
    };
  }, [d.version]);
  return <>
    <Hero d={d} now={now} />
    <Stats stats={d.stats} />
    <ResetCalendar key={d.selectedDate} selectedDate={d.selectedDate} version={d.version} marks={d.calendar} events={d.events} today={d.today} historyFrom={d.historyFrom} now={now} avatar={d.authorAvatar} />
  </>;
}
