import { Link, useLoaderData } from "react-router";
import { SITE } from "@aihot/site";
import type { Screen } from "@aihot/web/components/shell/screens";
import {
  AIHOT_CATEGORIES,
  type AiNewsHotItem,
  type AiNewsItem,
} from "../lib/aihot.shared";
import { fetchAiNewsHot, fetchAiNewsItems } from "../lib/aihot.server";

export const handle: Screen = { tab: "me", name: "AI 行业资讯" };

type TabKey = "selected" | "all" | "hot";

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "selected", label: "精选 · 24 小时" },
  { key: "all", label: "全部动态 · 24 小时" },
  { key: "hot", label: "热点榜" },
];

const CATEGORY_LABELS: Record<string, string> = {
  "ai-models": "模型",
  "ai-products": "产品",
  industry: "行业",
  paper: "论文",
  tip: "教程",
  opinion: "观点",
};

interface LoaderData {
  tab: TabKey;
  category: string | null;
  items: AiNewsItem[];
  hot: AiNewsHotItem[];
  error: string | null;
}

export async function loader({ request }: { request: Request }): Promise<LoaderData> {
  const url = new URL(request.url);
  const tabParam = url.searchParams.get("tab");
  const tab: TabKey = tabParam === "all" || tabParam === "hot" ? tabParam : "selected";
  const categoryParam = url.searchParams.get("category");
  const category =
    tab !== "hot" && categoryParam && (AIHOT_CATEGORIES as readonly string[]).includes(categoryParam)
      ? categoryParam
      : null;

  let items: AiNewsItem[] = [];
  let hot: AiNewsHotItem[] = [];
  let error: string | null = null;

  try {
    if (tab === "hot") {
      hot = await fetchAiNewsHot();
    } else {
      items = await fetchAiNewsItems(tab, category);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "AIHOT 接口暂不可用";
  }

  return { tab, category, items, hot, error };
}

export function meta() {
  return [
    { title: `AI 行业资讯 · ${SITE.name}` },
    {
      name: "description",
      content: "来自 AIHOT 的 AI 行业精选、全部动态与热点榜，与 OPCHOT 的 OPC 内容分开陈列。",
    },
    { property: "og:title", content: `AI 行业资讯 · ${SITE.name}` },
    { property: "og:description", content: "AIHOT 精选、全部动态与热点榜。" },
    { property: "og:type", content: "website" },
  ];
}

function hrefFor(tab: TabKey, category: string | null): string {
  const params = new URLSearchParams();
  if (tab !== "selected") params.set("tab", tab);
  if (category) params.set("category", category);
  const query = params.toString();
  return query ? `/ai-news?${query}` : "/ai-news";
}

function formatTime(value: string | null): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

const chipBase = "rounded-control px-3 py-1.5 text-[13px] font-semibold transition-colors";
const chipActive = "bg-accent text-accent-contrast";
const chipIdle = "border border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink";

export default function AiNewsPage() {
  const { tab, category, items, hot, error } = useLoaderData() as LoaderData;

  return (
    <div className="mx-auto w-full max-w-[900px] px-4 pb-20 pt-6 xl:px-6">
      <header className="border-b border-line pb-6">
        <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-ink-4">AI INDUSTRY WATCH</div>
        <h1
          data-page-title=""
          className="mt-2 text-[30px] font-black leading-[1.2] tracking-[-0.02em] text-ink sm:text-[38px]"
        >
          AI 行业资讯
        </h1>
        <p className="mt-3 max-w-[48em] text-[14.5px] leading-[1.8] text-ink-3">
          来自 AIHOT 的 AI 行业精选、全部动态与热点榜。它与 OPCHOT 的 OPC 内容分开陈列，不进入 OPC 日报和精选评分。
        </p>
        <p className="mt-2 text-[12px] leading-[1.7] text-ink-4">
          数据来源：
          <a href="https://aihot.news/" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
            AIHOT
          </a>
          ，仅展示标题与摘要索引，版权归原来源所有；
          <a href="https://aihot.news/terms" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
            使用规则
          </a>
          。
        </p>
      </header>

      <nav className="mt-5 flex flex-wrap items-center gap-2" aria-label="AI 行业资讯分类">
        {TABS.map((item) => (
          <Link
            key={item.key}
            to={hrefFor(item.key, item.key === "hot" ? null : category)}
            className={`${chipBase} ${tab === item.key ? chipActive : chipIdle}`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {tab !== "hot" && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Link
            to={hrefFor(tab, null)}
            className={`${chipBase} ${category === null ? chipActive : chipIdle}`}
          >
            全部
          </Link>
          {AIHOT_CATEGORIES.map((key) => (
            <Link
              key={key}
              to={hrefFor(tab, key)}
              className={`${chipBase} ${category === key ? chipActive : chipIdle}`}
            >
              {CATEGORY_LABELS[key] ?? key}
            </Link>
          ))}
        </div>
      )}

      {error ? (
        <div className="mt-8 rounded-card border border-line bg-surface p-8 text-center">
          <p className="text-[15px] font-semibold text-ink">AIHOT 接口暂时不可用</p>
          <p className="mt-2 text-[13px] text-ink-3">{error}</p>
          <a
            href="https://aihot.news/"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-block text-[13.5px] font-semibold text-accent hover:underline"
          >
            直接访问 AIHOT →
          </a>
        </div>
      ) : tab === "hot" ? (
        <HotList items={hot} />
      ) : (
        <ItemList items={items} />
      )}

      <footer className="mt-8 border-t border-line pt-4 text-[12px] leading-[1.8] text-ink-4">
        本页是 AIHOT 公开接口的阅读索引，不存储原文；每条内容均保留 AIHOT 站内链接与原文链接。商业使用前请确认
        <a href="https://aihot.news/terms" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
          AIHOT 使用规则
        </a>
        。
      </footer>
    </div>
  );
}

function ItemList({ items }: { items: AiNewsItem[] }) {
  if (!items.length) {
    return <p className="mt-8 rounded-card border border-line bg-surface p-8 text-center text-[13.5px] text-ink-3">这个时间窗口内没有内容，换个分类或稍后再看。</p>;
  }
  return (
    <ol className="mt-6 divide-y divide-line border-y border-line">
      {items.map((item) => (
        <li key={item.id} className="py-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0 rounded-mark bg-accent-softer px-1.5 py-0.5 text-[11px] font-semibold text-accent">
              {CATEGORY_LABELS[item.category] ?? item.category}
            </span>
            <div className="min-w-0 flex-1">
              <a
                href={item.links.aihot}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[16px] font-bold leading-[1.55] text-ink transition-colors hover:text-accent"
              >
                {item.title}
              </a>
              {item.summary && (
                <p className="mt-1.5 line-clamp-3 text-[13.5px] leading-[1.75] text-ink-3">{item.summary}</p>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-4">
                <span>{item.source.name}</span>
                <span>{formatTime(item.publishedAt)}</span>
                {item.links.original && (
                  <a
                    href={item.links.original}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    原文 ↗
                  </a>
                )}
                <a
                  href={item.links.aihot}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  AIHOT ↗
                </a>
              </div>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function HotList({ items }: { items: AiNewsHotItem[] }) {
  if (!items.length) {
    return <p className="mt-8 rounded-card border border-line bg-surface p-8 text-center text-[13.5px] text-ink-3">热点榜暂时为空，稍后再看。</p>;
  }
  return (
    <ol className="mt-6 space-y-3">
      {items.map((item) => (
        <li key={item.id} className="rounded-card border border-line bg-surface p-4">
          <div className="flex items-start gap-3">
            <span className="num flex size-7 shrink-0 items-center justify-center rounded-full bg-hot-soft text-[13px] font-black text-hot">
              {item.rank}
            </span>
            <div className="min-w-0 flex-1">
              <a
                href={item.links.aihot}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[15.5px] font-bold leading-[1.55] text-ink transition-colors hover:text-accent"
              >
                {item.title}
              </a>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-4">
                <span>{item.sourceCount} 个来源</span>
                <span>{formatTime(item.latestAt)}</span>
                {item.links.story && (
                  <a
                    href={item.links.story}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    事件页 ↗
                  </a>
                )}
                <a
                  href={item.links.aihot}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  AIHOT ↗
                </a>
              </div>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
