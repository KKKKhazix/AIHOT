import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { StoryFollowup, StoryFollowupsResponse, StoryRef } from "@aihot/contracts/site";
import { MoreLink } from "../../components/ui/Page";
import { relativeTime } from "../../lib/format";

/**
 * "事件后续": the other developments of the event this report belongs to, newest first, with a link to
 * the whole event. Loaded after the page so the article renders without waiting for it.
 */
export function StoryFollowups({ story, currentId }: { story: StoryRef; currentId: string }) {
  const [items, setItems] = useState<StoryFollowup[] | null>(null);
  const [more, setMore] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let started = false;
    setItems(null);
    const load = () => {
      if (started) return;
      started = true;
      fetch(`/api/site/stories/${encodeURIComponent(story.publicId)}/followups`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: StoryFollowupsResponse | null) => {
          if (!body || controller.signal.aborted) return;
          setItems(body.items.filter((d) => d.representative.id !== currentId));
          setMore(body.more);
        }).catch(() => {});
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { observer?.disconnect(); load(); }
    }, { rootMargin: "500px" });
    if (observer && anchor.current) observer.observe(anchor.current);
    else load();
    return () => { observer?.disconnect(); controller.abort(); };
  }, [story.publicId, currentId]);
  return <div ref={anchor}>
    <noscript><a href={`/story/${story.publicId}`}>查看事件全部后续</a></noscript>
    {items && items.length > 0 && <Followups items={items} more={more} story={story} />}
  </div>;
}

function Followups({items, more, story}: {items: StoryFollowup[]; more: boolean; story: StoryRef}) {
  return (
    <section className="mt-10 border-t border-line pt-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[14px] font-semibold text-ink">
          事件后续 <span className="num font-normal text-ink-4">· {items.length}{more ? "+" : ""}</span>
        </h2>
        <MoreLink to={`/story/${story.publicId}`}>查看事件全部</MoreLink>
      </div>
      <ul className="divide-y divide-line-soft">
        {items.map((d) => (
          <li key={d.factId}>
            <Link viewTransition to={`/items/${d.representative.id}`} className="group flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-3">
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="shrink-0 rounded-mark bg-accent-soft px-1 text-[10.5px] leading-[16px] text-accent">同事件</span>
                <span className="min-w-0 text-[13.5px] leading-snug text-ink-2 group-hover:text-accent sm:truncate">{d.representative.title}</span>
              </span>
              <span className="shrink-0 pl-[46px] text-[12px] text-ink-4 sm:pl-0" suppressHydrationWarning>
                {d.representative.source.name} · {relativeTime(d.representative.timelineAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
