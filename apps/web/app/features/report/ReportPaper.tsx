// One report with a newspaper's structure in the site's own look: a nameplate with its 报眼 (the box
// beside it for the issue and date), a band of the issue's figures, the front page (the lead, today's
// highlights and the page index), then one page per section in two columns, the neighbouring issues
// and a colophon. Colours, type and components are the site's; only the structure is a paper's.
// Rules are hairlines in two weights: line-strong closes the masthead and underlines a page's heading
// and the neighbours; line parts stories, columns and list rows. Nothing is set in solid ink. Stories
// sit in rows of two whose rules run across the page, each story as tall as its neighbour.
import { IntentLink } from "../../components/ui/IntentLink";
import { createContext, useContext, useState, type ReactNode } from "react";
import { REPORT_NAMES, reportDateLabel, reportDateLabelEn, type ReportCitation, type ReportDetail, type ReportNavigationEntry } from "@aihot/contracts/reports";
import { REPORTS, SEO_TITLES, SITE, subjectAfter, withSubject } from "@aihot/site";
import { ENGLISH } from "@aihot/contracts/english";
import { linkMentions, type MentionRun } from "@aihot/contracts/mentions";
import { sectionLabelIn } from "@aihot/contracts/taxonomy";
import { MentionText } from "../../components/ui/MentionText";
import { Badge } from "../../components/ui/Badge";
import { IconArrowLeft, IconArrowRight, IconArrowUpRight } from "../../components/icons";
import { Kicker } from "../../components/ui/Kicker";
import type { OutlineEntry } from "../../components/ui/OutlineSheet";
import { SourceAvatar } from "../../components/ui/SourceAvatar";
import { Halftone } from "./Halftone";
import { Nameplate } from "./Nameplate";
import { IssueDots } from "./IssueDots";
import { Picture } from "../../components/ui/Picture";
import { formatCount, monthDay } from "../../lib/format.ts";
import { EDITION, MOTTO, dateLine, dateMark, headline, kindName, metricItems, neighbourLabel, reportPath, shortDay } from "./format";
import { Link } from "../../lib/link";
import { L, translator, useLocale, useT, type Locale } from "../../lib/i18n";
import { jumpTo } from "../../lib/motion";

const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (c: ReportCitation) => c.itemId ?? (c.sourceUrl || c.title);
const anchorOf = (c: ReportCitation) => (c.itemId ? `r-${c.itemId}` : null);
const LINK = "inline-flex min-h-7 items-center gap-0.5 font-medium transition-colors hover:text-accent";
/** What comes before `noun` at the end of `phrase` ("往期 AI " of "往期 AI 周报"), so the kind's name is its own text. */
const before = (phrase: string, noun: string) => phrase.slice(0, -noun.length);

function Masthead({ report, index, quiet }: { report: ReportDetail; index: ReportNavigationEntry[]; quiet: boolean }) {
  const locale = useLocale();
  const t = useT();
  const mark = dateMark(report.kind, report.key, locale);
  return (
    <header className="pt-5 lg:pt-0">
      <div className="flex items-center justify-between gap-4 text-ui-caption text-ink-4">
        <span className="num">{dateLine(report.kind, report.key, locale)}</span>
        <span className={`hidden ${t("tracking-[0.3em]", "uppercase tracking-[0.08em]")} @[640px]:inline`}>{t(MOTTO[report.kind])}</span>
        <span>{t(EDITION[report.kind])}</span>
      </div>

      <div className="flex items-stretch justify-between gap-5 py-6 @[880px]:gap-10 @[880px]:py-8">
        <div className="flex min-w-0 flex-col justify-center">
          <h1 id="report-start" className="scroll-mt-[calc(var(--bar-h)+1.5rem)]">
            <span className="sr-only">
              {/* What the issue is searched by, as its title says, with its full date. */}
              {t(SEO_TITLES.latestReport(report.kind, dateLine(report.kind, report.key)), (ENGLISH?.seoTitles ?? SEO_TITLES).latestReport(report.kind, dateLine(report.kind, report.key, locale)))}
            </span>
            <Nameplate which={report.kind} className="block h-[44px] w-auto @[520px]:h-[58px] @[880px]:h-[74px] @[1040px]:h-[84px]" />
          </h1>
          <p className={`mt-3 text-ui-caption-md ${t("tracking-[0.36em]", "uppercase tracking-[0.08em]")} text-ink-4 @[880px]:mt-4 @[880px]:text-ui-caption-lg`}>{t(REPORTS.imprint, ENGLISH?.reports.imprint ?? REPORTS.imprint)}</p>
        </div>
        {/* 报眼: the box beside the nameplate, as a Chinese daily sets it: the issue and the date in the
            nameplate's dots, and on wider paper the issue calendar beside them. */}
        <div className="flex shrink-0 items-stretch well rounded-panel">
          <div className="flex w-[112px] flex-col items-center justify-center px-2 py-3 text-center @[880px]:w-[150px] @[880px]:py-4">
            <span className={`text-ui-caption-sm ${t("tracking-[0.2em]", "uppercase tracking-[0.08em]")} text-ink-4`}>{t(<>第 {report.issueNumber} 期</>, <>Issue {report.issueNumber}</>)}</span>
            <Halftone seed={`${report.kind}-${report.key}-date`} className="num mt-2 whitespace-nowrap text-ui-display-5 font-black leading-[0.95] tracking-[-0.04em] text-ink @[880px]:text-ui-display-9">
              {mark.figure}
            </Halftone>
            <span className="mt-2 text-ui-caption-md text-ink-2">{mark.top}</span>
            <span className="text-ui-caption-md text-ink-4">{mark.bottom}</span>
          </div>
          <IssueDots kind={report.kind} reportKey={report.key} issueNumber={report.issueNumber} index={index} className="hidden w-[176px] border-l border-line px-4 py-4 @[760px]:block @[880px]:w-[196px]" />
        </div>
      </div>

      {/* A quiet day has no figures to set and nothing to read through: the masthead just closes. */}
      {quiet ? (
        <div aria-hidden="true" className="border-t border-line-strong" />
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1.5 border-y border-line-strong py-3">
          {metricItems(report.metrics, locale).map((m) => (
            <span key={m.unit} className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
              <span className="num text-ui-heading-lg-sm font-bold leading-none tracking-[-0.02em] text-ink @[880px]:text-ui-heading-lg">{formatCount(m.value, locale)}</span>
              <span className="text-ui-caption text-ink-4">{m.unit}</span>
            </span>
          ))}
          <span className="ml-auto whitespace-nowrap text-ui-caption text-ink-4">{t(<>约 {report.readingMinutes} 分钟读完</>, <>{report.readingMinutes} min read</>)}</span>
        </div>
      )}
    </header>
  );
}

/** Source face and name, and the site's 一手 mark when first-hand. */
function Source({ c, size = 16 }: { c: ReportCitation; size?: number }) {
  const t = useT();
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <SourceAvatar name={c.sourceName} iconUrl={c.sourceIconUrl} iconSrcSet={c.sourceIconSrcSet} size={size} />
      <span className="truncate">{c.sourceName}</span>
      {c.firstParty && <Badge tone="accent">{t("一手", "Official")}</Badge>}
    </span>
  );
}

/**
 * The way on from a story: its original. Each story is one report (for an event, the one the edition
 * chose: first-hand first, then the best scored), so there is one place to go.
 */
function Original({ c, className = "" }: { c: ReportCitation; className?: string }) {
  const t = useT();
  return (
    <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={t(`阅读${c.sourceName}原文：${c.title}（新标签页）`, `Read the original from ${c.sourceName}: ${c.title} (new tab)`)} className={`${LINK} text-ui-caption-lg text-ink-3 ${className}`}>
      {t("原文 ", "Original ")}<IconArrowUpRight size={12} />
    </a>
  );
}

/**
 * Under a daily entry: the event's other developments, or other reports of the launch it stands for.
 * Titles only, each to its page; a withdrawn one stays, struck through.
 */
function Related({ items, className = "" }: { items: ReportCitation[]; className?: string }) {
  const t = useT();
  return (
    <ul className={`space-y-1.5 ${className}`}>
      {items.map((r) => (
        <li key={keyOf(r)} className="flex gap-2.5 text-ui-label-lg leading-[1.65]">
          <span className="mt-[9px] size-1 shrink-0 rounded-full bg-ink-4" aria-hidden="true" />
          <span className="min-w-0">
            {r.available && r.itemId ? (
              <IntentLink viewTransition to={`/items/${r.itemId}`} className="text-ink-2 transition-colors hover:text-accent">
                {r.title}
              </IntentLink>
            ) : (
              <span title={t(WITHDRAWN_NOTE)} className="text-ink-4 line-through">{r.title}</span>
            )}
            {r.available && <span className="ml-2 text-ui-caption text-ink-4">{r.sourceName}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** How many more sources reported the entry's event, and whether an earlier daily covered it. */
function Coverage({ c }: { c: ReportCitation }) {
  const t = useT();
  const others = t(<>另外 {c.otherSources} 家也报道了</>, <>{`Also covered by ${c.otherSources} other ${c.otherSources === 1 ? "source" : "sources"}`}</>);
  return (
    <>
      {!!c.otherSources && (c.storyId
        ? <IntentLink viewTransition to={`/story/${c.storyId}`} className="shrink-0 text-ink-4 transition-colors hover:text-accent">{others}</IntentLink>
        : <span className="shrink-0 text-ink-4">{others}</span>)}
      {c.followUp && <FollowUp day={c.followUp} />}
    </>
  );
}

/** The mark of an entry an earlier daily covered: this one carries what is new. */
function FollowUp({ day, className }: { day: string; className?: string }) {
  const t = useT();
  return <Badge className={className} title={t(`${monthDay(day)}的日报报道过这件事，这里是新进展`, `The ${monthDay(day, undefined, "en")} issue covered this story; here's what's new`)}>{t("跟进", "Update")}</Badge>;
}

/** One story: source, headline, at most four lines of summary, and the original at the foot. */
function Story({ c, slot, dated, className = "" }: { c: ReportCitation; slot: string; dated: boolean; className?: string }) {
  const locale = useLocale();
  const t = useT();
  return (
    <article id={anchorOf(c) ?? undefined} className={`flex min-w-0 scroll-mt-[calc(var(--bar-h)+1.5rem)] flex-col py-6 ${className}`}>
      <div className="flex items-center gap-2 text-ui-caption text-ink-3">
        <Source c={c} />
        {c.available && <Coverage c={c} />}
        {dated && c.publishedAt && <span className="num ml-auto shrink-0 text-ink-4">{shortDay(c.publishedAt, locale)}</span>}
      </div>
      {c.available ? (
        <>
          <h3 className="mt-3 text-ui-heading-md font-bold leading-[1.5] tracking-[-0.01em] text-ink [text-wrap:pretty] @[880px]:text-ui-heading">
            {c.itemId ? (
              <IntentLink viewTransition to={`/items/${c.itemId}`} className="transition-colors hover:text-accent">
                {c.title}
              </IntentLink>
            ) : (
              c.title
            )}
          </h3>
          {c.summary && <p className={`mt-2 line-clamp-4 text-ui-body leading-[1.85] text-ink-2 ${t("@[560px]:text-justify", "")}`}><Prose slot={slot} text={c.summary} /></p>}
          {!!c.related?.length && <Related items={c.related} className="mt-3" />}
          <div className="mt-auto pt-3">
            <Original c={c} />
          </div>
        </>
      ) : (
        <p className="mt-3 text-ui-body-sm leading-relaxed text-ink-4">
          <span className="line-through">{c.title}</span> · {t(WITHDRAWN_NOTE)}
        </p>
      )}
    </article>
  );
}

/**
 * Rows of two once the page is wide enough: both cells as tall as the taller, a hairline between them
 * and one rule under the row across the whole page, even under a single cell.
 */
export function Rows<T>({ items, children }: { items: T[]; children: (item: T, cell: string) => ReactNode }) {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return (
    <div>
      {rows.map((row, r) => (
        <div key={r} className="grid border-b border-line @[760px]:grid-cols-2">
          {row.map((item, i) => children(item, i === 0 ? "@[760px]:pr-10 @[1040px]:pr-12" : "border-t border-line @[760px]:border-l @[760px]:border-t-0 @[760px]:pl-10 @[1040px]:pl-12"))}
        </div>
      ))}
    </div>
  );
}

interface Page {
  id: string;
  label: string;
  summary: string | null;
  items: ReportCitation[];
}

/**
 * The story an issue leads with: the item it names.
 * Only a public item leads: a withdrawn one stays in its page, marked.
 */
function leadStoryOf(report: ReportDetail): ReportCitation | null {
  if (!report.leadItemId) return null;
  return report.sections.flatMap((s) => s.items).find((c) => c.itemId === report.leadItemId && c.available) ?? null;
}

const WITHDRAWN_NOTE = L("该内容已下架或调整展示方式。", "This item has been taken down or is now shown differently.");

/** The paragraph under the front page's headline: a daily's lead, a weekly or monthly's leading event or overview. */
function dekOf(report: ReportDetail, leadStory: ReportCitation | null): string | null {
  return report.kind === "daily" || !leadStory ? (report.lead?.leadParagraph ?? leadStory?.summary ?? report.overview) : leadStory.summary;
}

/** The issue's own paragraphs with the names they link, by where each stands (ReportPaper). */
const Linked = createContext<ReadonlyMap<string, MentionRun[]>>(new Map());

function Prose({ slot, text }: { slot: string; text: string }) {
  const runs = useContext(Linked).get(slot);
  return runs ? <MentionText runs={runs} /> : text;
}

/**
 * Sections as pages, named in the page's language. A story cited twice appears once, and
 * the story leading the front page is not repeated inside.
 */
function pagesOf(report: ReportDetail, leadStory: ReportCitation | null, locale: Locale): Page[] {
  const seen = new Set<string>(leadStory ? [keyOf(leadStory)] : []);
  return report.sections
    .map((s, i) => ({
      id: s.key ? `s-${s.key}` : `s-${i + 1}`,
      label: sectionLabelIn(s.label, locale, s.key),
      summary: s.summary,
      items: s.items
        .filter((c) => {
          const k = keyOf(c);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        }),
    }))
    .filter((p) => p.items.length > 0);
}

/**
 * The lead's picture; landscape pictures are cropped to between 16:10 and 2:1. A picture that is not
 * the lead's own (a weekly or monthly's, from its first highlight) is captioned with its story.
 */
function LeadPicture({ cover, onError, priority = false, className = "" }: { cover: NonNullable<ReportDetail["cover"]>; onError: () => void; priority?: boolean; className?: string }) {
  const t = useT();
  const ratio = cover.width && cover.height ? cover.width / cover.height : 16 / 9;
  const shown = ratio >= 1.25 ? Math.min(2, Math.max(1.6, ratio)) : Math.max(0.8, ratio);
  return (
    <figure className={className}>
      <div className="overflow-hidden well rounded-panel" style={{ aspectRatio: shown }}>
        <Picture src={cover.url} srcSet={cover.srcSet}
          sizes={priority ? "(min-width: 1700px) 780px, (min-width: 1580px) calc(100vw - 920px), (min-width: 1420px) calc(100vw - 880px), (min-width: 1176px) calc(100vw - 540px), (min-width: 1140px) calc(100vw - 600px), (min-width: 941px) calc(100vw - 260px), (min-width: 700px) calc(100vw - 144px), (min-width: 640px) 608px, calc(100vw - 32px)" :"auto, (min-width: 1180px) 300px, (min-width: 640px) 608px, calc(100vw - 32px)"}
          width={cover.width ?? undefined} height={cover.height ?? undefined}
          alt="" loading={priority ? "eager" : "lazy"} fetchPriority={priority ? "high" : "auto"} decoding="async" onError={onError} className="size-full object-cover" />
      </div>
      {cover.caption && <figcaption className="mt-2.5 line-clamp-2 text-ui-caption-lg leading-[1.6] text-ink-4">{t(<>图 · {cover.caption}</>, <>Image · {cover.caption}</>)}</figcaption>}
    </figure>
  );
}

/**
 * A weekly's or monthly's overview. Such an issue leading with an event sets the event on its front
 * page as a daily does, so the overview opens the issue above it.
 */
function Overview({ text }: { text: string }) {
  const t = useT();
  return (
    <section aria-label={t("本期导读", "Overview")} className="border-b border-line py-7 @[880px]:py-9">
      <Kicker>{t("本期导读", "Overview")}</Kicker>
      <p className={`mt-4 max-w-[46em] text-ui-body-xl leading-[1.9] text-ink-2 ${t("@[560px]:text-justify", "")} @[880px]:text-ui-subheading`}><Prose slot="overview" text={text} /></p>
    </section>
  );
}

/** The front page: the lead beside a column of today's highlights and the index of pages. */
function FrontPage({ report, pages, leadStory, count }: { report: ReportDetail; pages: Page[]; leadStory: ReportCitation | null; count: number }) {
  const locale = useLocale();
  const t = useT();
  const daily = report.kind === "daily";
  // A weekly or monthly leading with an event: the event's own summary; its overview stands above (Overview).
  const byEvent = daily || !!leadStory;
  // A picture that fails to load is dropped, and the lead is set as if it had none.
  const [broken, setBroken] = useState<string | null>(null);
  const cover = report.cover && report.cover.url !== broken ? report.cover : null;
  // A landscape picture opens the lead above its headline; a squarer one sits beside the paragraph.
  const wide = !cover?.width || !cover.height || cover.width / cover.height >= 1.25;
  const title = report.lead?.title ?? leadStory?.title ?? headline(report.kind, report.key, count, locale);
  const dek = dekOf(report, leadStory);
  const highlights = report.highlights.filter((h) => !leadStory || keyOf(h) !== keyOf(leadStory)).slice(0, 3);
  const inPage = new Set(pages.flatMap((p) => p.items.map((c) => c.itemId)).filter(Boolean));
  const period = daily ? t("今日", "Today's") : report.kind === "weekly" ? t("本周", "This week's") : t("本月", "This month's");
  const index = [...pages.map((p) => ({ id: p.id, label: p.label, n: t(`${p.items.length} 件`, `${p.items.length}`) })), ...(report.flashes.length > 0 ? [{ id: "s-flash", label: t("快讯", "Briefs"), n: t(`${report.flashes.length} 条`, `${report.flashes.length}`) }] : [])];

  return (
    <section aria-label={t("头版", "Front page")} className="grid @[880px]:grid-cols-[minmax(0,1fr)_300px] @[1040px]:grid-cols-[minmax(0,1fr)_340px]">
      {/* On a phone the headline comes before a landscape picture, so the first screen carries the news. */}
      <div id={leadStory ? (anchorOf(leadStory) ?? undefined) : undefined} className="flex min-w-0 scroll-mt-[calc(var(--bar-h)+1.5rem)] flex-col py-7 @[880px]:border-r @[880px]:border-line @[880px]:py-10 @[880px]:pr-10">
        <Kicker>{byEvent ? t("头条", "Lead story") : t("本期导读", "Overview")}</Kicker>
        {cover && wide && <LeadPicture cover={cover} onError={() => setBroken(cover.url)} priority className="order-2 mt-5 @[560px]:order-1" />}
        <h2 className="order-1 mt-4 text-ui-title-6 font-black leading-[1.28] tracking-[-0.03em] text-ink [text-wrap:balance] @[520px]:text-ui-display-4 @[560px]:order-2 @[1040px]:text-ui-display-7 @[1040px]:leading-[1.22]">
          {leadStory?.itemId ? (
            <IntentLink viewTransition to={`/items/${leadStory.itemId}`} className="transition-colors hover:text-accent">
              {title}
            </IntentLink>
          ) : (
            title
          )}
        </h2>
        {dek && (
          <div className={cover && !wide ? "order-3 mt-6 grid gap-6 @[640px]:grid-cols-[minmax(0,1fr)_minmax(0,38%)] @[880px]:mt-7" : "order-3"}>
            <p className={`text-ui-body-xl leading-[1.9] text-ink-2 @[880px]:text-ui-subheading ${cover && !wide ? "" : t("mt-6 @[560px]:text-justify @[880px]:mt-7", "mt-6 @[880px]:mt-7")}`}><Prose slot="dek" text={dek} /></p>
            {cover && !wide && <LeadPicture cover={cover} onError={() => setBroken(cover.url)} />}
          </div>
        )}
        {leadStory && (
          <div className="order-4 mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-ui-caption-lg text-ink-3">
            <Source c={leadStory} size={18} />
            <Coverage c={leadStory} />
            <Original c={leadStory} />
          </div>
        )}
        {!!leadStory?.related?.length && <Related items={leadStory.related} className="order-5 mt-5 border-t border-line pt-4" />}
      </div>

      <aside className="min-w-0 border-t border-line py-7 @[880px]:border-t-0 @[880px]:py-10 @[880px]:pl-8">
        {highlights.length > 0 && (
          <>
            <Kicker>{t(<>{period}看点</>, <>{period} highlights</>)}</Kicker>
            <ol className="mt-2">
              {highlights.map((h, i) => {
                const anchor = anchorOf(h);
                const to = anchor && inPage.has(h.itemId) ? `#${anchor}` : h.itemId ? `/items/${h.itemId}` : h.sourceUrl;
                if (!h.available) {
                  return (
                    <li key={keyOf(h)} className="flex gap-3.5 border-b border-line py-4">
                      <span className="num w-6 shrink-0 text-ui-title-2 font-black leading-[0.95] tracking-[-0.03em] text-ink-4">{i + 1}</span>
                      <span className="min-w-0 text-ui-label-lg leading-[1.55] text-ink-4">
                        <span className="line-through">{h.title}</span>
                        <span className="mt-1 block text-ui-caption">{t(WITHDRAWN_NOTE)}</span>
                      </span>
                    </li>
                  );
                }
                return (
                  <li key={keyOf(h)}>
                    <Link to={to} viewTransition={to.startsWith("/")} onClick={to.startsWith("#") ? (e) => jumpTo(e, to.slice(1)) : undefined} className="group flex gap-3.5 border-b border-line py-4">
                      <span className="num w-6 shrink-0 text-ui-title-2 font-black leading-[0.95] tracking-[-0.03em] text-accent">{i + 1}</span>
                      <span className="min-w-0">
                        <span className="block text-ui-body font-bold leading-[1.55] text-ink transition-colors group-hover:text-accent">{h.title}</span>
                        <span className="mt-1.5 block truncate text-ui-caption text-ink-4">{h.sourceName}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </>
        )}
        {index.length > 0 && (
          <nav aria-label={t("本期版面", "Sections")} className={highlights.length > 0 ? "mt-8" : ""}>
            <Kicker>{t("本期版面", "Sections")}</Kicker>
            <ol className="mt-3">
              {index.map((p, i) => (
                <li key={p.id}>
                  <a href={`#${p.id}`} onClick={(e) => jumpTo(e, p.id)} className="group flex items-baseline gap-2 py-1.5 text-ui-label-lg">
                    <span className="num w-7 shrink-0 text-ui-body-sm font-bold text-ink">{pad(i + 1)}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-2 transition-colors group-hover:text-accent">{p.label}</span>
                    <span className="num shrink-0 text-ui-caption text-ink-4">{p.n}</span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        )}
      </aside>
    </section>
  );
}

/**
 * The front page of a day with nothing new: the lead alone across the page, in the lead's own type,
 * saying so and naming the hours it covers. No highlights, pages or index follow.
 */
function QuietFront({ lead }: { lead: NonNullable<ReportDetail["lead"]> }) {
  const t = useT();
  return (
    <section aria-label={t("头版", "Front page")} className="pt-10 @[880px]:pt-16">
      <h2 className="text-ui-title-6 font-black leading-[1.28] tracking-[-0.03em] text-ink [text-wrap:balance] @[520px]:text-ui-display-4 @[1040px]:text-ui-display-7 @[1040px]:leading-[1.22]">
        {lead.title}
      </h2>
      {lead.leadParagraph && <p className="mt-6 max-w-[46em] text-ui-body-xl leading-[1.9] text-ink-2 @[880px]:mt-7 @[880px]:text-ui-subheading">{lead.leadParagraph}</p>}
    </section>
  );
}

/** A page of the report: its number in the accent beside its name. */
export function SectionPage({ id, no, label, children }: { id: string; no?: number; label: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-t`} className="scroll-mt-[calc(var(--bar-h)+1.5rem)] pt-12 @[880px]:pt-16">
      <header className="flex items-baseline gap-3 border-b border-line-strong pb-3 @[880px]:gap-4">
        {no !== undefined && <span className="num text-ui-title-2 font-black leading-none tracking-[-0.03em] text-accent @[880px]:text-ui-title-5">{pad(no)}</span>}
        <h2 id={`${id}-t`} className="min-w-0 text-ui-heading-lg font-black leading-[1.25] tracking-[-0.02em] text-ink @[880px]:text-ui-title-4">
          {label}
        </h2>
      </header>
      {children}
    </section>
  );
}

/** Two columns with a hairline between them, once the page is wide enough (快讯). */
const COLUMNS = "@[760px]:columns-2 @[760px]:gap-x-12 @[760px]:[column-rule:1px_solid_var(--line)]";

/** Issues change through these links, never by a sideways swipe: on iOS that would fight the edge swipe back. */
function Neighbours({ report, index }: { report: ReportDetail; index: ReportNavigationEntry[] }) {
  const locale = useLocale();
  const t = useT();
  const titleOf = (key: string) => index.find((e) => e.key === key)?.title ?? `${withSubject(kindName(report.kind, locale))} · ${key}`;
  const cell = "group flex min-w-0 flex-col py-6";
  const title = "mt-2.5 line-clamp-2 text-ui-body-lg font-bold leading-[1.5] text-ink transition-colors group-hover:text-accent @[880px]:text-ui-heading-sm";
  return (
    <nav aria-label={report.kind === "daily" ? t("前后日报", "Previous and next issues") : t("前后各期", "Previous and next issues")} className="mt-16 grid grid-cols-2 border-y border-line-strong">
      {report.prev ? (
        <Link to={reportPath(report.kind, report.prev)} className={`${cell} pr-5 @[880px]:pr-10`}>
          <span className="inline-flex items-center gap-1 text-ui-caption text-ink-4">
            <IconArrowLeft size={13} /> {neighbourLabel(report.kind, report.prev, "prev", undefined, locale)}
          </span>
          <span className={title}>{titleOf(report.prev)}</span>
        </Link>
      ) : (
        <span />
      )}
      {report.next ? (
        <Link to={reportPath(report.kind, report.next)} className={`${cell} items-end border-l border-line pl-5 text-right @[880px]:pl-10`}>
          <span className="inline-flex items-center gap-1 text-ui-caption text-ink-4">
            {neighbourLabel(report.kind, report.next, "next", undefined, locale)} <IconArrowRight size={13} />
          </span>
          <span className={title}>{titleOf(report.next)}</span>
        </Link>
      ) : (
        <span className="border-l border-line" />
      )}
    </nav>
  );
}

function History({ report, index }: { report: ReportDetail; index: ReportNavigationEntry[] }) {
  const locale = useLocale();
  const t = useT();
  // Weeklies and monthlies only (the daily has its archive page): their 更早 leads here, so every issue is listed.
  const others = index.filter((e) => e.key !== report.key);
  if (others.length === 0) return null;
  const label = REPORT_NAMES[report.kind];
  return (
    <section id="report-history" className="scroll-mt-[calc(var(--bar-h)+1.5rem)] pt-12">
      <Kicker>{t(<>{before(subjectAfter("往期", label), label)}{label}</>, <>Past issues</>)}</Kicker>
      <ul className="mt-3">
        {others.map((e) => (
          <li key={e.key}>
            <Link to={reportPath(report.kind, e.key)} className="group flex items-baseline gap-4 border-b border-line py-3">
              <span className="num w-[108px] shrink-0 text-ui-caption-lg text-ink-4">{t(reportDateLabel(report.kind, e.key), reportDateLabelEn(report.kind, e.key))}</span>
              <span className="min-w-0 flex-1 truncate text-ui-body-sm text-ink-2 transition-colors group-hover:text-accent">{e.title ?? `${SITE.name} ${kindName(report.kind, locale)} · ${e.key}`}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The issue's pages for the phone outline: the front page, each page under its number, then 快讯. */
export function reportOutline(report: ReportDetail, locale: Locale): OutlineEntry[] {
  const t = translator(locale);
  const pages = pagesOf(report, leadStoryOf(report), locale);
  if (pages.length === 0 && report.flashes.length === 0) return [];
  return [
    { id: "report-start", text: t("头版", "Front page"), level: 2, mark: "" },
    ...pages.map((p, i) => ({ id: p.id, text: p.label, level: 2, mark: pad(i + 1), note: t(`${p.items.length} 件`, `${p.items.length}`) })),
    ...(report.flashes.length > 0 ? [{ id: "s-flash", text: t("快讯", "Briefs"), level: 2, mark: pad(pages.length + 1), note: t(`${report.flashes.length} 条`, `${report.flashes.length}`) }] : []),
  ];
}

export function ReportPaper({ report, index }: { report: ReportDetail; index: ReportNavigationEntry[] }) {
  const locale = useLocale();
  const t = useT();
  const daily = report.kind === "daily";
  const leadStory = leadStoryOf(report);
  const pages = pagesOf(report, leadStory, locale);
  const count = pages.reduce((sum, p) => sum + p.items.length, 0) + (leadStory ? 1 : 0);
  // Only a daily comes out with nothing in it: a day the editors judged with nothing new (REPORTS.quiet).
  const quiet = count === 0 && report.flashes.length === 0;
  // Each name links once in the issue, where a reader meets it first: the texts in the order they are drawn.
  const slots: Array<[string, string | null]> = [
    ...(!daily && leadStory ? [["overview", report.overview] as [string, string | null]] : []),
    ["dek", dekOf(report, leadStory)],
    ...pages.flatMap((p) => [[`page:${p.id}`, p.summary] as [string, string | null], ...p.items.map((c) => [`story:${p.id}:${keyOf(c)}`, c.available ? c.summary : null] as [string, string | null])]),
  ];
  const runs = linkMentions(slots.map(([, text]) => text), report.mentions);
  const linked = new Map(slots.map(([slot], i) => [slot, runs[i]]));
  return (
    <Linked.Provider value={linked}>
    <article className="@container [overflow-wrap:anywhere]">
      <Masthead report={report} index={index} quiet={quiet} />
      {quiet ? (
        report.lead && <QuietFront lead={report.lead} />
      ) : (
        <>
          {!daily && leadStory && report.overview && <Overview text={report.overview} />}
          <FrontPage report={report} pages={pages} leadStory={leadStory} count={count} />
        </>
      )}

      {pages.map((p, i) => (
        <SectionPage key={p.id} id={p.id} no={i + 1} label={p.label}>
          {p.summary && (
            <p className={`border-b border-line py-5 text-ui-body-plus leading-[1.9] text-ink-2 ${t("@[560px]:text-justify", "")}`}>
              <span className="mr-2 font-semibold text-accent">{t("本版导读", "In this section")}</span>
              <Prose slot={`page:${p.id}`} text={p.summary} />
            </p>
          )}
          <Rows items={p.items}>{(c, cell) => <Story key={`${p.id}-${keyOf(c)}`} c={c} slot={`story:${p.id}:${keyOf(c)}`} dated={!daily} className={cell} />}</Rows>
        </SectionPage>
      ))}

      {report.flashes.length > 0 && (
        <SectionPage id="s-flash" no={pages.length + 1} label={t("快讯", "Briefs")}>
          <ul className={`${COLUMNS} @[1040px]:columns-3`}>
            {report.flashes.map((f, i) => (
              <li key={`${keyOf(f)}-${i}`} className="flex break-inside-avoid gap-2.5 border-b border-line py-3 text-ui-body-sm-plus leading-[1.65]">
                <span className="mt-[9px] size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                <span className="min-w-0">
                  {!f.available ? (
                    <span className="text-ink-4">
                      <span className="line-through">{f.title}</span>
                      <span className="ml-2 text-ui-caption">{t(WITHDRAWN_NOTE)}</span>
                    </span>
                  ) : f.itemId ? (
                    <Link viewTransition to={`/items/${f.itemId}`} className="text-ink transition-colors hover:text-accent">
                      {f.title}
                    </Link>
                  ) : (
                    <span className="text-ink">{f.title}</span>
                  )}
                  {f.available && <span className="ml-2 text-ui-caption text-ink-4">{f.sourceName}</span>}
                  {f.available && f.followUp && <FollowUp day={f.followUp} className="ml-2 align-[1px]" />}
                </span>
              </li>
            ))}
          </ul>
        </SectionPage>
      )}

      <Neighbours report={report} index={index} />
      {!daily && <History report={report} index={index} />}
      <footer className="py-10 text-center">
        <div className={`text-ui-label font-semibold ${t("tracking-[0.6em]", "uppercase tracking-[0.08em]")} text-ink-4`}>{t("（本期完）", "— End of issue —")}</div>
        <p className="mt-3 text-ui-caption text-ink-4">
          {t(
            <>{`${SITE.name} `}{REPORT_NAMES[report.kind]}根据公开报道自动{daily ? "整理" : "汇总"}，每条都附原文 ·{" "}</>,
            <>{`${SITE.name} ${kindName(report.kind, locale)} is ${daily ? "compiled" : "summarized"} automatically from public reporting, with every item linked to its source · `}</>,
          )}
          <Link to={daily ? "/daily/archive" : "#report-history"} viewTransition={daily} className="font-medium text-ink-3 transition-colors hover:text-accent">
            {daily ? t("日报合订本", "Daily archive") : t(`往期${REPORT_NAMES[report.kind]}`, "Past issues")}
          </Link>
        </p>
      </footer>
    </article>
    </Linked.Provider>
  );
}
