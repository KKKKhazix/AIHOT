import type { HotStripEntry } from "@aihot/contracts/site";
import { IconArrowRight, IconMinus, IconTrendDown, IconTrendUp } from "../../components/icons";
import { Faces } from "../hot/Faces";
import { formatCount } from "../../lib/format";
import { Link } from "../../lib/link";
import { useLocale, useT } from "../../lib/i18n";

// As on the original list: the top three in the ranking colours at the heaviest weight.
const RANK_COLOR = ["text-ui-body font-black text-rank-1", "text-ui-body font-black text-rank-2", "text-ui-body font-black text-rank-3"];

function hrefOf(e: HotStripEntry): string {
  return e.storyPublicId ? `/story/${e.storyPublicId}` : e.itemId ? `/items/${e.itemId}` : "/hot";
}

/** Where the heat is heading, as a small arrow (a "新" mark for a story new to the ranking). */
function TrendMark({ trend }: { trend: HotStripEntry["trend"] }) {
  const t = useT();
  if (trend === "up") return <IconTrendUp size={14} strokeWidth={2.2} className="text-hot" aria-label={t("热度上升", "Rising")} />;
  if (trend === "down") return <IconTrendDown size={14} strokeWidth={2.2} className="text-ink-4" aria-label={t("热度回落", "Cooling")} />;
  if (trend === "new") return <span className="rounded-full bg-accent-soft px-1.5 text-ui-micro-8 font-semibold leading-4 text-accent">{t("新", "New")}</span>;
  if (trend === "unknown") return null; // sources behind on collection: no comparison to show
  return <IconMinus size={14} strokeWidth={2.2} className="text-ink-4" aria-label={t("热度持平", "Steady")} />;
}

/**
 * The top of the hot ranking on the home page, kept quiet: a live dot, coloured ranks and titles, then
 * columns of fixed width so every row lines up — who is talking (精选组 faces, from sm), "N 热度" and an arrow for
 * where it is heading. The whole row lights up on hover. Phones show the top three in one line each, so
 * the feed starts on the first screen.
 */
export function HotTopics({ entries }: { entries: HotStripEntry[] }) {
  const t = useT();
  const locale = useLocale();
  if (entries.length === 0) return null;
  return (
    <section
      aria-labelledby="hot-topics"
      className="card relative mb-4 overflow-hidden bg-[radial-gradient(120%_90%_at_100%_0%,var(--hot-soft),transparent_55%)] px-3.5 pb-1 pt-2.5 lg:mb-6 lg:px-5 lg:pb-2 lg:pt-3.5"
    >
      <div className="flex items-center justify-between lg:mb-1">
        <h2 id="hot-topics" className="flex items-center gap-2 text-ui-body-sm font-semibold text-ink">
          <span className="live-dot text-hot" aria-hidden="true" />
          {t("当前热点", "Trending now")}
        </h2>
        <Link to="/hot" className="group -my-2.5 -mr-1.5 inline-flex h-11 items-center gap-1 px-1.5 text-ui-caption-lg text-ink-3 transition-colors hover:text-accent lg:my-0 lg:mr-0 lg:h-auto lg:px-0 touch:h-11">
          {t("完整榜单", "Full list")} <IconArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>
      <ol>
        {entries.slice(0, 5).map((e, i) => (
          <li key={e.storyPublicId ?? e.itemId ?? e.rank} className={i >= 3 ? "max-sm:hidden" : undefined}>
            <Link viewTransition
              to={hrefOf(e)}
              className="group -mx-2 grid min-h-11 sm:min-h-0 touch:min-h-11 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-tile px-2 py-1.5 transition-colors hover:bg-bg-sunk/70 active:bg-bg-sunk sm:grid-cols-[20px_minmax(0,1fr)_120px_64px_20px] sm:gap-x-4 sm:py-2 dark:hover:bg-bg-muted/40"
            >
              <span className={`num text-center leading-none ${RANK_COLOR[i] ?? "text-ui-body-sm font-bold text-rank-rest"}`}>{e.rank}</span>
              <span className="line-clamp-1 min-w-0 text-ui-body-sm-plus font-semibold leading-[1.5] text-ink transition-colors group-hover:text-accent lg:text-ui-body-sm">{e.title}</span>
              <span className="hidden justify-end sm:flex">
                <Faces participants={e.participants} total={e.participantCount} size={20} interactive={false} />
              </span>
              <span className="flex items-center justify-end gap-2.5 sm:contents">
                <span className="whitespace-nowrap text-right text-ui-caption-lg text-ink-4" title={t("热度指数", "Heat index")}>
                  <span className="num text-ui-label-lg font-semibold text-ink-2">{formatCount(Math.round(e.heat), locale)}</span> {t("热度", "heat")}
                </span>
                <span className="flex w-5 justify-center">
                  <TrendMark trend={e.trend} />
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
