import type { StoryFollowup, StoryFollowupsResponse, StoryRef } from "@aihot/contracts/site";
import { MoreLink } from "../../components/ui/Page";
import { relativeTime } from "../../lib/format";
import { Link } from "../../lib/link";
import { useLocale, useT } from "../../lib/i18n";

/**
 * "事件后续": the other developments of the event this report belongs to, newest first, with a link to
 * the whole event. When all reports belong to a single development yet the event stands in search, still
 * link visibly to the event page so both readers and crawlers reach it without relying on <noscript>.
 */
export function StoryFollowups({ followups, story, currentId }: { followups: StoryFollowupsResponse | null; story: StoryRef; currentId: string }) {
  const t = useT();
  const items = followups?.items.filter((d) => d.representative.id !== currentId) ?? [];
  if (items.length > 0) return <Followups items={items} more={followups!.more} story={story} />;
  if (!story.indexable) return null;
  return (
    <section className="mt-10 border-t border-line pt-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="shrink-0 text-ui-body-sm font-semibold text-ink">{t("所属事件", "Part of the story")}</h2>
        <MoreLink to={`/story/${story.publicId}`}>{t("查看完整事件", "See the full story")}</MoreLink>
      </div>
      <Link viewTransition to={`/story/${story.publicId}`} className="mt-2 block text-ui-body-sm leading-snug text-ink-2 transition-colors hover:text-accent">
        {story.title}
      </Link>
    </section>
  );
}

function Followups({items, more, story}: {items: StoryFollowup[]; more: boolean; story: StoryRef}) {
  const t = useT();
  const locale = useLocale();
  return (
    <section className="mt-10 border-t border-line pt-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-ui-body-sm font-semibold text-ink">
          {t("事件后续 ", "Updates on this story ")}<span className="num font-normal text-ink-4">· {items.length}{more ? "+" : ""}</span>
        </h2>
        <MoreLink to={`/story/${story.publicId}`}>{t("查看完整事件", "See the full story")}</MoreLink>
      </div>
      <ul className="divide-y divide-line-soft">
        {items.map((d) => (
          <li key={d.factId}>
            <Link viewTransition to={`/items/${d.representative.id}`} className="group flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="shrink-0 rounded-mark bg-accent-soft px-1 text-ui-micro-8 leading-[16px] text-accent">{t("同事件", "Same story")}</span>
                <span className="min-w-0 text-ui-label-lg leading-snug text-ink-2 group-hover:text-accent sm:truncate">{d.representative.title}</span>
              </span>
              <span className="shrink-0 pl-[46px] text-ui-caption text-ink-4 sm:pl-0" suppressHydrationWarning>
                {d.representative.source.name} · {relativeTime(d.representative.timelineAt, undefined, locale)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
