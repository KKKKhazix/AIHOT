import { data as withHeaders, Link, useLoaderData } from "react-router";
import type { Route } from "./+types/topics";
import { apiGet, releaseBoundCache } from "../lib/api.server";
import { pageMeta } from "../lib/seo";

interface TopicSummary {
  slug: string;
  name: string;
  group: "company" | "field" | "genre";
  definition: string;
  total: number;
  recent: number;
  indexable: boolean;
  latestAt: string | null;
}

export async function loader({ request }: { request: Request }) {
  const upstream = new Headers();
  const data = await apiGet<{ topics: TopicSummary[]; refreshAt: string | null }>("/api/site/topics", { signal: request.signal, responseHeaders: upstream });
  return withHeaders(data, { headers: releaseBoundCache(data.refreshAt, 300, Date.now(), upstream) });
}

export function meta() {
  return pageMeta({ title: "主题", description: "按公司与模型、技术方向、内容形态聚合的 AI 主题页：OpenAI、Anthropic、Agent、多模态、论文与教程等 38 个方向。", path: "/topics", image: "/og/pages/topics.png" });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

const GROUPS = [
  { key: "company", name: "公司与模型", blurb: "按厂商与模型系追踪：谁发了什么、又赢了哪一局" },
  { key: "field", name: "技术方向", blurb: "按技术领域深挖：Agent、多模态、具身智能……" },
  { key: "genre", name: "内容形态", blurb: "按内容类型浏览：论文、教程、观点、政策……" },
] as const;

export default function TopicsPage() {
  const { topics } = useLoaderData<typeof loader>();
  return (
    <div className="pb-10">
      <header className="pb-2 pt-5 lg:pt-1">
        <h1 className="text-[24px] font-semibold leading-[1.3] text-ink">按主题看 AI</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          按公司与模型、技术方向、内容形态浏览 <span className="num">{topics.length}</span> 个主题，持续汇集近期焦点与精选。
        </p>
      </header>
      {GROUPS.map((g) => (
        <section key={g.key} aria-labelledby={`topics-${g.key}`} className="pt-8">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2 id={`topics-${g.key}`} className="text-[15px] font-bold text-ink">
              {g.name}
            </h2>
            <p className="text-[12px] text-ink-4">{g.blurb}</p>
          </div>
          <ul className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {topics
              .filter((t) => t.group === g.key)
              .map((t) => (
                <li key={t.slug}>
                  <Link
                    to={`/topics/${t.slug}`}
                    prefetch="intent"
                    aria-label={`查看${t.name}相关精选文章`}
                    className="card card-hover group flex h-full flex-col px-5 py-[18px]"
                  >
                    <span className="text-[15px] font-bold text-ink transition-colors group-hover:text-accent">{t.name}</span>
                    <span className="mt-1.5 line-clamp-2 flex-1 text-[12.5px] leading-[1.7] text-ink-3">{t.definition}</span>
                    <span className="mono mt-3 text-[11.5px] text-accent">
                      查看 {t.total} 条精选 <span className="inline-block transition-transform duration-200 group-hover:translate-x-0.5">→</span>
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
