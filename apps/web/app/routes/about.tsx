import { Fragment, useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { IntentLink } from "../components/ui/IntentLink";
import { useLoaderData } from "react-router";
import type { SiteContact, SiteStats } from "@aihot/contracts/site";
import { ABOUT, POLICY, REPORTS, SEO_TITLES, SITE, subjectAfter } from "@aihot/site";
import { ENGLISH } from "@aihot/contracts/english";
import type { Route } from "./+types/about";
import { apiGet, cachedPage, pagePathname } from "../lib/api.server";
import { pageReuse } from "../lib/page-reuse";
import { breadcrumbLd, organizationLd, pageMeta } from "../lib/seo";
import { Kicker } from "../components/ui/Kicker";
import { buttonClass } from "../components/ui/Controls";
import { IconArrowRight } from "../components/icons";
import { SignalRiver, type RiverSource } from "../features/about/SignalRiver";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";
import { Link } from "../lib/link";
import { useSwapped } from "../lib/motion";
import { apiIn, L, localeOf, translator, useLocale, useT, type Text, type Translate } from "../lib/i18n";

export const handle: Screen = { tab: "me", name: L("关于", "About") };
export { pageHeaders as headers } from "../lib/api.server";
export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();

export async function loader({ request }: { request: Request }) {
  const [contact, stats] = await Promise.all([
    apiGet<SiteContact>("/api/site/contact", { signal: request.signal }).catch(() => null),
    apiGet<SiteStats>(apiIn("/stats", localeOf(pagePathname(request))), { signal: request.signal }).catch(() => null),
  ]);
  return cachedPage(300, { contact, stats });
}

export function meta({ location }: Route.MetaArgs) {
  const locale = localeOf(location.pathname);
  const t = translator(locale);
  return pageMeta({
    locale,
    title: t(SEO_TITLES.about, ENGLISH?.seoTitles.about ?? SEO_TITLES.about),
    rawTitle: true,
    description: t(ABOUT.description, ENGLISH?.about.description ?? ABOUT.description),
    path: "/about",
    image: "/og/pages/about.png",
    jsonLd: [
      organizationLd(),
      breadcrumbLd([{ name: SITE.name, path: "/" }, { name: L(`关于 ${SITE.name}`, `About ${SITE.name}`), path: "/about" }], locale),
    ],
  });
}

/** The page's own words (ABOUT) in English, from the site's English edition. */
const EN = ENGLISH?.about ?? null;

const NO_SOURCES: RiverSource[] = [];
const BACK = { to: "/more", label: L("我的", "Me") };

/** 3.6 万 from ten thousand up, digits with separators below; English writes 36K and 1.2M. */
function figure(n: number, t: Translate): { value: string; unit: string } {
  const en = n >= 999_500 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M` : `${Math.round(n / 1000)}K`;
  return n >= 10_000 ? t({ value: (n / 10_000).toFixed(1).replace(/\.0$/, ""), unit: "万" }, { value: en, unit: "" }) : { value: n.toLocaleString("en-US"), unit: "" };
}

function Figure({ n, unit }: { n: number; unit: string }) {
  const t = useT();
  const f = figure(n, t);
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="num text-ui-title-5 font-black leading-none tracking-[-0.03em] text-ink xl:text-ui-display-2">{f.value}</span>
      <span className="text-ui-label text-ink-3">
        {f.unit}
        {unit}
      </span>
    </div>
  );
}

const KIND_ORDER: Array<[string, Text]> = [
  ["x_search", "X"],
  ["rss", "RSS"],
  ["web_list", L("网页", "Web")],
  ["mp_account", L("公众号", "WeChat")],
  ["json_list", L("接口", "API")],
];

/**
 * The stage columns' rules: one column on phones, two by two from sm, and from lg four in a row whose
 * edges fall on the river's stage boundaries.
 */
const STAGE_CELL = [
  "sm:pr-6 lg:pr-6",
  "border-t sm:border-l sm:border-t-0 sm:pl-6 lg:px-6",
  "border-t sm:pr-6 lg:border-l lg:border-t-0 lg:px-6",
  "border-t sm:border-l sm:pl-6 lg:border-t-0 lg:px-6",
];

interface Stage {
  no: string;
  title: string;
  figure: ReactNode;
  text: string;
  note: ReactNode;
}

/** A figure's unit in English, one or many (the site's English edition); the Chinese one where it has none. */
const unitEn = (n: number, unit: { one: string; many: string } | undefined, zhUnit: string) => (unit ? (n === 1 ? unit.one : unit.many) : zhUnit);

function stagesOf(stats: SiteStats | null, t: Translate): Stage[] {
  const kinds = stats ? KIND_ORDER.filter(([k]) => stats.sourceKinds[k]).map(([k, label]) => `${t(label)} ${stats.sourceKinds[k]}`).join(" · ") : null;
  const units = ENGLISH?.reports.metricUnits;
  return [
    {
      no: "01",
      title: t("采集", "Collect"),
      figure: stats && <Figure n={stats.sources} unit={t("个信源", stats.sources === 1 ? "source" : "sources")} />,
      text: t(ABOUT.steps.collect, EN?.steps.collect ?? ABOUT.steps.collect),
      note: kinds,
    },
    {
      no: "02",
      title: t("收录", "Store"),
      figure: stats && <Figure n={stats.items} unit={t("条动态", stats.items === 1 ? "item" : "items")} />,
      text: t(ABOUT.steps.store, EN?.steps.store ?? ABOUT.steps.store),
      note: stats && t(<>过去 24 小时收进 {stats.day.collected.toLocaleString("en-US")} 条</>, <>{stats.day.collected.toLocaleString("en-US")} collected in the last 24 hours</>),
    },
    {
      no: "03",
      title: t("精选", "Pick"),
      figure: stats && <Figure n={stats.selected} unit={t(REPORTS.metricUnits.selectedCount, unitEn(stats.selected, units?.selectedCount, REPORTS.metricUnits.selectedCount))} />,
      text: t(ABOUT.steps.select, EN?.steps.select ?? ABOUT.steps.select),
      note: stats && t(<>过去 24 小时 {stats.day.selected} 条进了精选</>, <>{stats.day.selected.toLocaleString("en-US")} picked in the last 24 hours</>),
    },
    {
      no: "04",
      title: t("成刊", "Publish"),
      figure: stats && <Figure n={stats.dailies} unit={t(REPORTS.metricUnits.reportsCovered, unitEn(stats.dailies, units?.reportsCovered, REPORTS.metricUnits.reportsCovered))} />,
      text: t(ABOUT.steps.publish, EN?.steps.publish ?? ABOUT.steps.publish),
      note: t("也可以用 RSS、API、MCP 订阅", "Also available via RSS, API and MCP"),
    },
  ];
}

/** The maker's round avatar before the greeting; it steps aside if the image fails. */
function MakerFace({ src }: { src: string }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img src={src} alt={t(`${ABOUT.maker?.name ?? ""}的头像`, `${EN?.maker?.name ?? ABOUT.maker?.name ?? ""}'s photo`)} width={48} height={48} onError={() => setFailed(true)} className="size-11 shrink-0 rounded-full bg-bg-sunk object-cover ring-1 ring-line xl:size-12" />;
}

function QrCard({ src, kind, title, note }: { src: string; kind: string; title: string; note: string }) {
  const t = useT();
  return (
    <figure className="card flex items-center gap-5 p-5">
      <img src={src} alt={t(`${kind}二维码`, `${kind} QR code`)} width={112} height={112} loading="lazy" className="size-[104px] shrink-0 rounded-tile border border-line bg-white object-contain p-1.5 sm:size-[112px]" />
      <figcaption className="min-w-0">
        <div className="text-ui-caption text-ink-4">{kind}</div>
        <div className="mt-1 text-ui-body-lg font-semibold leading-snug text-ink">{title}</div>
        <p className="mt-2 text-ui-label leading-[1.7] text-ink-3">{note}</p>
      </figcaption>
    </figure>
  );
}

/**
 * The optional maker block (ABOUT.maker): a greeting on the left, the contact codes that are set on the
 * right. Without the contact settings (the api did not answer) the codes stay out, as the figures do.
 */
function Maker({ maker, contact }: { maker: NonNullable<typeof ABOUT.maker>; contact: SiteContact | null }) {
  const t = useT();
  // The WeChat and Feishu codes are for readers in China: English pages leave them out.
  const codes = t([
    contact?.wechatQr && maker.wechat ? <QrCard key="wechat" src={contact.wechatQr} kind={maker.wechat.kind} title={maker.wechat.title} note={maker.wechat.note} /> : null,
    contact?.feishuQr && maker.feishu ? <QrCard key="feishu" src={contact.feishuQr} kind={maker.feishu.kind} title={maker.feishu.title} note={maker.feishu.note} /> : null,
  ], []).filter(Boolean);
  return (
    <section aria-labelledby="maker" className="mt-20 grid gap-10 xl:mt-28 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-16">
      <div>
        <Kicker>{t("做这个站的人", "Who's behind this")}</Kicker>
        <h2 id="maker" className="mt-4 flex items-center gap-3.5 text-ui-title-2 font-black leading-[1.3] tracking-[-0.02em] text-ink xl:gap-4 xl:text-ui-display-1">
          {contact?.makerAvatar && <MakerFace src={contact.makerAvatar} />}
          <span>
            {t(<>嗨，我是 <span className="whitespace-nowrap text-accent">{maker.name}</span></>, <>Hi, I'm <span className="whitespace-nowrap text-accent">{EN?.maker?.name ?? maker.name}</span></>)}
          </span>
        </h2>
        <div className="mt-5 space-y-4 text-ui-body-plus leading-[1.9] text-ink-2 xl:text-ui-body-xl">
          {t(maker.greeting, EN?.maker?.greeting ?? maker.greeting).map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p className="text-ink-3">
            {t(
              <>
                它一直在改，改了什么都写在
                <Link viewTransition to="/changelog" className="text-accent hover:underline">
                  更新日志
                </Link>
                里；有想法、遇到问题，去
                <Link viewTransition to="/feedback" className="text-accent hover:underline">
                  反馈页
                </Link>
                告诉我。
              </>,
              <>
                You can follow what’s changed in the <Link viewTransition to="/changelog" className="text-accent hover:underline">changelog</Link>. Have an idea or hit a problem? Tell me on the{" "}
                <Link viewTransition to="/feedback" className="text-accent hover:underline">
                  feedback page
                </Link>
                .
              </>,
            )}
          </p>
        </div>
      </div>
      {codes.length > 0 && (
        <div className="grid content-start gap-3">
          <h3 className="text-ui-body font-semibold text-ink">{t("如果觉得有点用，欢迎加入", "If you find it useful, come join us")}</h3>
          {codes}
        </div>
      )}
    </section>
  );
}

/** The latest 精选 under the river's paper; it moves on each time an item reaches the paper. */
function Latest({ item, className = "" }: { item: SiteStats["latest"][number] | undefined; className?: string }) {
  const t = useT();
  // The first is there with the page; each one after it rises in where the last one was.
  const moved = useSwapped(item?.id ?? null);
  if (!item) return null;
  return (
    <IntentLink viewTransition to={`/items/${item.id}`} className={`group block ${className}`}>
      <span className="text-ui-caption-sm font-semibold tracking-[0.2em] text-accent">{t("最近精选", "Latest top pick")}</span>
      <span key={item.id} className={`mt-1.5 block ${moved ? "animate-fade-up" : ""}`}>
        {/* Two lines held whatever the title's length, so what follows does not move as the titles change. */}
        <span className="line-clamp-2 min-h-[3.1em] text-ui-label-lg font-semibold leading-[1.55] text-ink transition-colors group-hover:text-accent">{item.title}</span>
        <span className="mt-1 block truncate text-ui-caption text-ink-4">{item.source}</span>
      </span>
    </IntentLink>
  );
}

export default function AboutPage() {
  const t = useT();
  const locale = useLocale();
  const { contact, stats } = useLoaderData<typeof loader>();
  const [focus, setFocus] = useState<number | null>(null);
  const [at, setAt] = useState(0);
  const shown = useRef(0);
  const sources = useMemo(() => stats?.sampleSources ?? NO_SOURCES, [stats]);
  const stages = useMemo(() => stagesOf(stats, t), [stats, t]);
  const headline = t(ABOUT.headline, EN?.headline ?? ABOUT.headline);
  const latest = stats?.latest ?? [];
  // A pulse reaches the paper every second or so; the headline under it changes at most every 2.8s.
  const onArrive = useCallback(() => {
    const now = Date.now();
    if (now - shown.current < 2800 || latest.length < 2) return;
    shown.current = now;
    setAt((i) => (i + 1) % latest.length);
  }, [latest.length]);

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-14 lg:pt-3">
      <PhoneBar back={BACK} title={t(`关于 ${SITE.name}`, `About ${SITE.name}`)} />
      <header className="grid items-end gap-8 pt-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:pt-0">
        <div>
          <Kicker>{t(ABOUT.kicker, EN?.kicker ?? ABOUT.kicker)}</Kicker>
          <h1 data-page-title="" className="mt-5 text-ui-display-1 font-black leading-[1.18] tracking-[-0.03em] text-ink [text-wrap:balance] sm:text-ui-display-6 xl:text-ui-display-8 2xl:text-ui-display-9">
            {headline[0]}
            <br />
            <span className="text-accent">{headline[1]}</span>
          </h1>
          <p className="mt-5 max-w-[36em] text-ui-body-plus leading-[1.85] text-ink-3 xl:text-ui-subheading-sm">
            {/* The Chinese lead writes {sources} without spaces and the page adds them; the English one has its own. */}
            {t(ABOUT.lead, EN?.lead ?? ABOUT.lead).split("{sources}").map((part, i) => (
              <Fragment key={i}>
                {i > 0 && (stats
                  ? t(<>{" "}<span className="num font-semibold text-ink">{stats.sources}</span>{" "}</>, <span className="num font-semibold text-ink">{stats.sources.toLocaleString("en-US")}</span>)
                  : t(ABOUT.sourcesFallback, EN?.sourcesFallback ?? ABOUT.sourcesFallback))}
                {part}
              </Fragment>
            ))}
          </p>
        </div>
        <div className="flex flex-wrap gap-3 lg:pb-2">
          <IntentLink to="/" className={buttonClass("primary", "lg")}>
            {t(<>看今天的精选 <IconArrowRight size={15} /></>, <>See today's top picks <IconArrowRight size={15} /></>)}
          </IntentLink>
          <IntentLink to="/daily" className={buttonClass("secondary", "lg")}>
            {t("读最新日报", `Read the latest ${SITE.subject} Daily`)}
          </IntentLink>
        </div>
      </header>

      <section aria-labelledby="how" className="mt-10 xl:mt-14">
        <h2 id="how" className="sr-only">
          {t(`${SITE.name} 怎么工作`, `How ${SITE.name} works`)}
        </h2>
        <SignalRiver sources={sources} focus={focus} onArrive={onArrive} className="h-[230px] sm:h-[300px] lg:h-[360px] 2xl:h-[420px]">
          <Latest item={latest[at]} className="absolute left-[75%] top-[calc(42%+42px)] hidden w-[25%] px-6 lg:block" />
        </SignalRiver>
        <p className="sr-only">{t(
          `示意图：每条线是一个信源；线汇成一束束，代表同一件事的多篇报道；经过精选的闸门，只有少数几束通过，${subjectAfter("汇入每天的", "日报")}。`,
          `Diagram: each line is a source. Lines gather into bundles, each grouping the reports on one story. At the top-picks gate, only a few bundles get through and flow into each day's ${SITE.subject} Daily.`,
        )}</p>
        <Latest item={latest[at]} className="mt-2 border-t border-line pt-4 lg:hidden" />
        <ol className="mt-4 grid grid-cols-1 border-t border-line-strong sm:grid-cols-2 lg:mt-0 lg:grid-cols-4">
          {stages.map((s, i) => (
            <li
              key={s.no}
              tabIndex={0}
              onPointerEnter={() => setFocus(i)}
              onPointerLeave={() => setFocus(null)}
              onFocus={() => setFocus(i)}
              onBlur={() => setFocus(null)}
              className={`border-line py-6 outline-none transition-colors ${STAGE_CELL[i]} ${focus === i ? "bg-accent-softer" : ""}`}
            >
              <div className="flex items-baseline gap-2.5">
                <span className="num text-ui-caption font-bold tracking-[0.12em] text-accent">{s.no}</span>
                <h3 className="text-ui-subheading-sm font-bold text-ink">{s.title}</h3>
              </div>
              {s.figure && <div className="mt-4">{s.figure}</div>}
              <p className="mt-3 text-ui-body-sm leading-[1.8] text-ink-3">{s.text}</p>
              {s.note && <p className="mt-3 text-ui-caption text-ink-4">{s.note}</p>}
            </li>
          ))}
        </ol>
      </section>

      {ABOUT.maker && (locale === "zh" || EN?.maker) && <Maker maker={ABOUT.maker} contact={contact} />}

      <p className="mt-16 well rounded-card px-5 py-4 text-ui-label leading-[1.85] text-ink-3">
        {t(
          <>
            {ABOUT.copyright[0]}
            <Link viewTransition to="/feedback" className="text-accent hover:underline">
              反馈页
            </Link>
            {ABOUT.copyright[1]}
          </>,
          // The copyright and takedown statement stands in Chinese only; English points to it on the Chinese about page.
          EN && <>{EN.copyright[0]}<a href="/about" className="text-accent hover:underline">{EN.copyright[1]}</a>{EN.copyright[2]}</>,
        )}
      </p>

      <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5 text-ui-caption-lg text-ink-4">
        <span>{t<string | null>(SITE.footerNote, ENGLISH ? ENGLISH.footerNote : SITE.footerNote)}</span>
        <nav className="flex gap-5" aria-label={t("规则与隐私", "Terms and privacy")}>
          {/* The terms and the privacy notice have no English edition: English links to the Chinese pages. */}
          {t(
            <Link
              viewTransition
              id={ABOUT.termsAnchor ?? undefined}
              to="/terms"
              className="transition-colors hover:text-accent"
            >
              {POLICY.terms.name}
            </Link>,
            <a id={ABOUT.termsAnchor ?? undefined} href="/terms" className="transition-colors hover:text-accent">
              {ENGLISH?.policyLinks.terms ?? POLICY.terms.name}
            </a>,
          )}
          {t(
            <Link viewTransition to="/privacy" className="transition-colors hover:text-accent">
              隐私说明
            </Link>,
            <a href="/privacy" className="transition-colors hover:text-accent">
              {ENGLISH?.policyLinks.privacy ?? "Privacy"}
            </a>,
          )}
        </nav>
      </footer>
    </div>
  );
}
