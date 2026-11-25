// One report in a feed. Desktop (≥ 700px): a white card beside the time rail. Phones: a compact row with
// the time in the source line, the bookmark at hand, the reason in one line and duplicate reports
// behind one button that opens a sheet. One markup, two presentations. The card is a link as a whole, so
// addresses in its text read short as plain words.
import { memo } from "react";
import { shortAddresses } from "@aihot/contracts/addresses";
import { IntentLink } from "../../components/ui/IntentLink";
import type { GroupInfo, FeedItemSummary, TimelineFilters } from "@aihot/contracts/site";
import { categoryLabel, displayTagIn } from "@aihot/contracts/taxonomy";
import { ITEM_COPY } from "@aihot/site";
import { ENGLISH } from "@aihot/contracts/english";
import { SameEventBadge, SelectedBadge } from "../../components/ui/Badge";
import { ScoreLabel } from "../../components/ui/Score";
import { beijingTime } from "@aihot/contracts/time";
import { MediaThumbs, SourceLine, StarButton, readTone } from "./parts";
import { GroupButton, GroupSources } from "./ReadingGroup";
import { QuotedLine } from "../item/QuotedPost";
import { rememberPreview } from "../item/preview";
import { Link } from "../../lib/link";
import { useLocale, useT } from "../../lib/i18n";

export interface FeedItemProps {
  item: FeedItemSummary;
  group?: GroupInfo | null;
  filters?: TimelineFilters;
  read?: boolean;
  onOpen?: (id: string) => void;
  /** Show category and tags under the text (全部动态, topics, search). */
  showTags?: boolean;
  /** Tags that belong to a topic page: those link to /topics/<slug> instead of a noindex filter. */
  tagTopics?: Record<string, string>;
  /** Current topic page's slug, so cards there do not repeat a self-link tag. */
  currentTopicSlug?: string;
  /** The time the item sits at in its list; phones show it in the source line (desktop: on the rail). */
  at?: string;
  /** In the 精选 list itself, where every card is a pick: the 精选 badge would say nothing (同事件 still shows). */
  inPicks?: boolean;
}

export const FeedItem = memo(function FeedItem({ item, group, filters, read = false, onOpen, showTags = false, tagTopics, currentTopicSlug, at, inPicks = false }: FeedItemProps) {
  const t = useT();
  const locale = useLocale();
  const isX = item.channel === "x" && !!item.x;
  const open = () => {
    rememberPreview(item);
    onOpen?.(item.id);
  };
  const showSources = !!group && (group.additionalSourceCount > 0 || group.reportCount > 1);
  const tags = showTags
    ? item.tags
        .flatMap((tag) => {
          if (currentTopicSlug && tagTopics?.[tag] === currentTopicSlug) return [];
          const label = displayTagIn(tag, locale);
          if (!label) return [];
          const slug = tagTopics?.[tag];
          return [{ tag, label, to: slug ? `/topics/${slug}` : `/all?tag=${encodeURIComponent(tag)}`, nofollow: !slug }];
        })
        .slice(0, 3)
    : [];

  return (
    <article className="relative min-w-0 lg:card lg:card-hover lg:px-[18px] lg:pb-[14px] lg:pt-[15px]" data-item-id={item.id}>
      <header className="flex min-h-[22px] items-center gap-1.5 text-ui-caption-lg leading-[18px] text-ink-4 lg:min-h-[18px] lg:gap-2">
        <SourceLine item={item} className="text-ink-4" />
        {at && (
          <time dateTime={at} className="mono shrink-0 text-ui-caption lg:hidden">
            · {beijingTime(at)}
          </time>
        )}
        {item.selected && (item.sameEvent || !inPicks) && (
          <span className="hidden lg:inline-flex">
            {item.sameEvent ? <SameEventBadge /> : <SelectedBadge />}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-2 lg:gap-1.5">
          <span className="hidden lg:inline-flex">
            <ScoreLabel score={item.score} />
          </span>
          <span className="lg:hidden">
            <ScoreLabel score={item.score} compact />
          </span>
          <span className="-my-[11px] -mr-3 inline-flex lg:-my-1 lg:mr-0">
            <StarButton item={item} className="size-11 lg:size-[26px] lg:touch:before:absolute lg:touch:before:-inset-[9px] lg:touch:before:content-['']" />
          </span>
        </span>
      </header>

      {isX ? (
        item.summary ? <p className={`mt-1.5 whitespace-pre-line text-ui-body leading-[1.75] line-clamp-5 lg:mt-2 lg:line-clamp-4 ${readTone(read, "text-ink")}`}>
          <IntentLink viewTransition to={`/items/${item.id}`} onClick={open} className="after:absolute after:inset-0 after:content-['']">
            {shortAddresses(item.summary)}
          </IntentLink>
        </p> : <IntentLink viewTransition to={`/items/${item.id}`} onClick={open} aria-label={t(`查看 ${item.x!.authorName} 的帖子`, `View ${item.x!.authorName}'s post`)} className="absolute inset-0" />
      ) : (
        <>
          <h3 className={`mt-1.5 line-clamp-2 text-ui-subheading-sm font-[650] leading-[1.5] lg:mt-2 lg:line-clamp-none lg:leading-[1.55] ${readTone(read, "text-ink")}`}>
            <IntentLink viewTransition to={`/items/${item.id}`} onClick={open} className="after:absolute after:inset-0 after:content-['']">
              {item.title}
            </IntentLink>
          </h3>
          {item.summary && <p className="mt-1 line-clamp-2 text-ui-body-sm-plus leading-[1.7] text-ink-3 lg:mt-2 lg:line-clamp-3 lg:text-ui-body lg:leading-[1.75]">{shortAddresses(item.summary)}</p>}
        </>
      )}

      {isX && item.x!.media.length > 0 && <MediaThumbs media={item.x!.media} className="mt-2.5" />}
      {isX && item.x!.quoted?.text && <QuotedLine quoted={item.x!.quoted} />}

      {(tags.length > 0 || (showTags && item.category)) && (
        <div className="relative z-10 mt-2 hidden flex-wrap gap-x-2.5 gap-y-1 text-ui-caption text-ink-4 lg:flex">
          {showTags && item.category && (
            <Link to={`/all?category=${item.category}`} rel="nofollow" className="hover:text-accent">
              {categoryLabel(item.category, locale)}
            </Link>
          )}
          {tags.map(({ tag, label, to, nofollow }) => (
            <Link key={tag} to={to} rel={nofollow ? "nofollow" : undefined} className="hover:text-accent">
              #{label}
            </Link>
          ))}
        </div>
      )}

      {item.sameEvent && (
        <p className="relative z-10 mt-2 line-clamp-1 text-ui-caption-lg text-ink-4">
          {t("同一件事，精选收录的是", "Same story in Top Picks: ")}
          <Link viewTransition to={`/items/${item.sameEvent.id}`} className="text-ink-3 transition-colors hover:text-accent">
            {t(`《${item.sameEvent.title}》`, `“${item.sameEvent.title}”`)}
          </Link>
        </p>
      )}
      {group && showSources && (
        <div className="mt-2 hidden lg:block">
          <GroupSources group={group} filters={filters} parentId={item.id} />
        </div>
      )}

      {item.reason && (
        <div className="mt-1 lg:mt-3 lg:border-t lg:border-line-soft lg:pt-3">
          <p className="line-clamp-1 text-ui-label leading-[1.65] text-note lg:line-clamp-none lg:leading-[1.75]">{t(`${ITEM_COPY.reasonLabel}：`, `${ENGLISH?.reasonLabel ?? ITEM_COPY.reasonLabel}: `)}{item.reason}</p>
        </div>
      )}

      {/* Phones: duplicate reports open in a sheet. */}
      {group && showSources && <GroupButton group={group} filters={filters} parentId={item.id} />}
    </article>
  );
});
