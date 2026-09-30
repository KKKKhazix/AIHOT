import { SITE, withSubject } from "@aihot/industry/site";
import { data as withHeaders, Link, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/topic";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { loadOr404, releaseBoundCache } from "../lib/api.server";
import { breadcrumbLd, pageMeta, titled } from "../lib/seo";
import { DayList, Pagination } from "../features/feed/DayList";
import { EmptyState, MoreLink } from "../components/ui/Page";

// 主题HTML和导航数据使用API同一个绝对截止，不能跨过发布时刻。
export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

interface TopicPageData {
  topic: { slug: string; name: string; group: string; definition: string; total: number; indexable: boolean; related: Array<{ slug: string; name: string }> };
  items: FeedItemSummary[];
  page: number;
  pageCount: number;
  refreshAt: string | null;
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const page = params.page ? Number(params.page) : 1;
  if (params.page !== undefined && (!/^\d+$/.test(params.page) || page < 1)) throw new Response("Not found", { status: 404 });
  // Page 1 lives at the topic's own address (308).
  if (params.page === "1") throw redirect(`/topics/${params.slug}`, 308);
  const upstream = new Headers();
  const data = await loadOr404<TopicPageData>(`/api/site/topics/${encodeURIComponent(params.slug)}?page=${page}`, { signal: request.signal, responseHeaders: upstream });
  return withHeaders({ data }, { headers: releaseBoundCache(data.refreshAt, 60, Date.now(), upstream) });
}

export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: titled("主题不存在") }, { name: "robots", content: "noindex" }];
  const { topic, page } = loaderData.data;
  const path = page > 1 ? `/topics/${topic.slug}/page/${page}` : `/topics/${topic.slug}`;
  return pageMeta({
    title: page > 1 ? `${topic.name} · 第 ${page} 页` : topic.name,
    description: topic.definition,
    path,
    image: `/og/topics/${topic.slug}.png`,
    noindex: !topic.indexable,
    jsonLd: breadcrumbLd([{ name: SITE.name, path: "/" }, { name: "主题", path: "/topics" }, { name: topic.name, path: `/topics/${topic.slug}` }]),
  });
}

export default function TopicPage() {
  const { data } = useLoaderData<typeof loader>();
  const { topic, items, page, pageCount } = data;
  const href = (p: number) => (p <= 1 ? `/topics/${topic.slug}` : `/topics/${topic.slug}/page/${p}`);
  const first = (page - 1) * 20 + 1;
  const last = first + items.length - 1;
  return (
    <div className="pb-6">
      <header className="pb-4 pt-5 lg:pt-1">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-[22px] font-bold leading-[1.35] text-ink">{topic.name}</h1>
          <span className="hidden pt-2 lg:block">
            <MoreLink to="/topics">全部主题</MoreLink>
          </span>
        </div>
        <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-ink-3">{topic.definition}</p>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <span className="text-[12.5px] text-ink-4">
            <span className="num mr-1 text-[20px] font-bold text-ink">{topic.total.toLocaleString("zh-CN")}</span>条精选
          </span>
          {topic.related.length > 0 && (
            <span className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
              <span className="text-ink-4">相关主题</span>
              {topic.related.map((r) => (
                <Link key={r.slug} to={`/topics/${r.slug}`} className="chip">
                  {r.name}
                </Link>
              ))}
            </span>
          )}
        </div>
      </header>

      <div className="mb-1 mt-2 flex items-baseline justify-between">
        <h2 className="text-[18px] font-bold text-ink">最新精选</h2>
        {items.length > 0 && (
          <span className="num text-[12px] text-ink-4">
            第 {first}–{last} 条 · 共 {topic.total.toLocaleString("zh-CN")} 条
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <div className="lg:card">
          <EmptyState title="这个主题暂时还没有精选内容" />
        </div>
      ) : (
        <DayList items={items} />
      )}
      <Pagination page={page} pageCount={pageCount} href={href} />
    </div>
  );
}
