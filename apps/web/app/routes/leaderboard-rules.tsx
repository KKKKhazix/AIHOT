// Public method statement for the leaderboard (method v17, docs/leaderboard.md).
// The copy states how rankings are actually computed; it changes only together with the method.
import { Link, useLoaderData } from "react-router";
import type { LbRulesData } from "@aihot/contracts/leaderboard";
import { SITE } from "@aihot/industry/site";
import { edgeTtl, loadOr404 } from "../lib/api.server";
import { breadcrumbLd, pageMeta } from "../lib/seo";
import { pct } from "../features/leaderboard/format";
import { fullDateTime } from "../lib/format";
import { IconArrowLeft, IconChevronRight } from "../components/icons";
import { AsideCard, ReadingLayout } from "../components/ui/Page";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "leaderboard" };

export async function loader({ request }: { request: Request }) {
  return loadOr404<LbRulesData>("/api/site/leaderboard/rules", { signal: request.signal });
}

export function meta() {
  return pageMeta({
    title: "模型榜评分与排名的计算方法",
    description: `查看 ${SITE.name} 模型榜如何核验配置、按能力维度分配权重、校准共同评测，并计算 ${SITE.name} 评分。`,
    path: "/leaderboard/rules",
    image: "/og/pages/leaderboard.png",
    jsonLd: breadcrumbLd([
      { name: "模型榜", path: "/leaderboard" },
      { name: "排序怎么算", path: "/leaderboard/rules" },
    ]),
  });
}

export function headers() {
  return edgeTtl(600);
}

const STEPS = [
  {
    n: "01",
    title: "先核验型号与运行配置",
    body: "统一模型名称、版本与推理配置，按预先确定的规则选代表运行，不挑最高分。统一固定工具且全程同一型号可以采用；多模型回退、混合模型与专属异构 Agent 系统不混排。配置未公开就保留未知，不据此断言混用了模型。",
  },
  {
    n: "02",
    title: "按能力分配，重复证据不加权",
    body: "综合榜按八个能力维度等权分配，每维占 12.5%。维度内再分配到评测题族，同一题库的重复成绩、榜单切片与已用分项的综合指标不叠加计权。新增评测先核对题目与协议的重叠关系。",
  },
  {
    n: "03",
    title: "用同协议参照校准真实分差",
    body: "只比较同一评测协议下双方都有的成绩，用预先固定参照组的四分位距校准连续分差，避免把微小领先和大幅领先都当成同一票。缺测不补分，未知标准误不当成零。",
  },
  {
    n: "04",
    title: "算成评分，方便比较",
    body: `汇总共同评测的相对成绩差，寻找冲突较少的参考顺序。在保持顺序的条件下，将共同成绩分差拟合为 0–100 的 ${SITE.name} 评分；各项原始成绩供进一步核对。`,
  },
];

const FAQ = [
  {
    q: `${SITE.name} 评分怎么看？`,
    a: "0–100 分，越高表示该模型在本榜的综合表现越强。分数根据共同评测的实际分差拟合，不是按名次逐个扣分，也不会自动给榜首满分。它不是正确率或胜率；请在同一榜单、同一轮内比较。",
  },
  {
    q: "为什么不同名次可能同分？",
    a: "评分只显示一位小数；差距很小，或各项评测存在冲突、无法用一个分数完全表达时，可能同分。此时仍按原来的共同评测排序，不额外编造 0.1 分的差距。",
  },
  {
    q: "参考位次能说明谁一定更强吗？",
    a: "不能。它是当前公开成绩在指定规则下的浏览顺序，不是全世界所有任务的绝对能力排名。实际体验还受产品版本、推理预算、工具环境与任务类型影响。相邻位次不代表显著差距。",
  },
  {
    q: "证据覆盖百分比是什么？",
    a: "它表示该模型已有成绩覆盖了多少预设评测权重。覆盖高说明已知的范围更广，不代表能力更强，也不是正确率。缺失的份额不转给其他评测，更不补成零分或平均分。",
  },
  {
    q: "共同评测的相对成绩差是胜率吗？",
    a: "不是。它汇总双方共同评测中经过固定参照校准的连续分差，正负只表示相对方向，不表示获胜概率或显著领先。两两比较可能相互冲突，完整参考顺序要同时处理这些关系。",
  },
  {
    q: "为什么不直接取每个模型的最高成绩？",
    a: "最高成绩可能对应更高推理预算、不同工具或不同评测协议。代表配置的选择规则必须先确定，不能看到结果后挑分。使用同一推理档位名称，也不保证计算量完全相同；具体配置在成绩旁保留。",
  },
  {
    q: "评测重复、污染和误差能全部消除吗？",
    a: "不能。我们按公开题库与协议检查重复，并限制同一题族的份额；无法确认的题目重叠和训练污染仍是局限。上游未公开样本级结果或标准误时，无法补造可靠误差，也不会把未知当成零。",
  },
  {
    q: "新模型什么时候会出现？",
    a: `${SITE.name} 每天检查四次上游结果。只有评测方实际发布了新模型的成绩，才能用于参考顺序；网页刷新、价格更新或我们的抓取时间，都不算重新评测。`,
  },
  {
    q: "某家榜单暂时打不开，会怎样？",
    a: "仍有效的来源快照可继续使用。相同评测版本内，临时漏行最多沿用最近七天已核验的记录；仍在公开榜中保留的有效成绩，不因数值长期不变被删除。官方撤回、更正、换版会相应失效或替换，不保留历史最高分。整轮计算失败时保留上一轮有效榜及原时间。",
  },
  {
    q: "价格或速度会影响参考顺序吗？",
    a: "都不会。价格只供你了解 API 的使用成本，统一按每百万 Token 展示，并保留厂商官方来源。它不代表订阅费用。",
  },
];

const SECTIONS = [
  ["#rules-steps", "四步形成参考顺序"],
  ["#rules-budgets", "证据怎么分配"],
  ["#rules-faq", "常见问题"],
  ["#rules-details", "计算细节"],
] as const;

/** One question or detail block: a hairline row that opens in place. */
function Disclosure({ summary, children, defaultOpen = false }: { summary: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="disclosure group border-b border-line" open={defaultOpen}>
      <summary className="flex items-center justify-between gap-3 py-4 text-[14px] font-semibold text-ink transition-colors hover:text-accent">
        {summary}
        <span className="shrink-0 text-[18px] font-normal leading-none text-ink-4 transition-transform duration-200 group-open:rotate-45" aria-hidden="true">
          +
        </span>
      </summary>
      <div className="max-w-[64em] pb-5 text-[13px] leading-[1.8] text-ink-3">{children}</div>
    </details>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="mono text-[11px] font-semibold tracking-[0.14em] text-accent">{children}</span>;
}

export default function LeaderboardRulesPage() {
  const { run, budgets, anchors } = useLoaderData<typeof loader>();
  const aside = (
    <>
      <AsideCard title="本页内容" className="hidden lg:block">
        <nav aria-label="本页内容" className="-mx-2 -mb-1">
          {SECTIONS.map(([href, label]) => (
            <a key={href} href={href} className="block rounded-control px-2 py-2 text-[13.5px] text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink">
              {label}
            </a>
          ))}
        </nav>
      </AsideCard>
      <AsideCard title="当前方法">
        <dl className="space-y-2 text-[12.5px]">
          <div className="flex gap-3">
            <dt className="w-14 shrink-0 text-ink-4">方法版本</dt>
            <dd className="mono min-w-0 text-ink-2">{run.methodologyVersion}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="w-14 shrink-0 text-ink-4">本轮计算</dt>
            <dd className="mono min-w-0 text-ink-2">{fullDateTime(run.generatedAt)}</dd>
          </div>
        </dl>
      </AsideCard>
      <AsideCard title="继续看">
        <nav aria-label="继续看" className="-mx-2 -mb-1">
          {[
            ["/leaderboard", "模型榜"],
            ["/leaderboard/sources", "每一份评测证据"],
          ].map(([to, label]) => (
            <Link key={to} to={to!} viewTransition={to !== "/leaderboard"} prefetch="intent" className="flex items-center justify-between rounded-control px-2 py-2 text-[13.5px] text-ink-2 transition-colors hover:bg-bg-sunk hover:text-ink">
              {label}
              <IconChevronRight size={14} className="text-ink-4" />
            </Link>
          ))}
        </nav>
      </AsideCard>
    </>
  );
  return (
    <>
    <PhoneBar back={{ to: "/leaderboard", label: "模型榜" }} title="排序怎么算" />
    <ReadingLayout aside={aside}>
      <Link to="/leaderboard" className="hidden items-center gap-1.5 py-2 text-[13px] text-ink-3 transition-colors hover:text-accent lg:inline-flex">
        <IconArrowLeft size={14} /> 返回模型榜
      </Link>

      <header className="lg:pt-3">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">排序怎么算</h1>
        <p className="mt-1.5 text-[13px] text-ink-3">了解 {SITE.name} 评分怎么算，以及每个分数背后的公开成绩。</p>
      </header>

      <section className="mt-6 rounded-panel border border-line-soft bg-bg-sunk px-6 py-7 dark:bg-bg-muted/40 md:px-10 md:py-9">
        <Eyebrow>EVIDENCE BEFORE CONCLUSIONS</Eyebrow>
        <h2 className="mt-2 text-[19px] font-bold text-ink">先看评分，再看所长。</h2>
        <p className="mt-2.5 text-[13px] leading-[1.8] text-ink-3">综合榜与四类榜单最多展示 30 个模型。{SITE.name} 评分帮助快速比较；分项成绩说明各有所长，证据覆盖说明已有评测的范围。</p>
        <p className="mt-1.5 text-[13px] leading-[1.8] text-ink-3">评分是基于公开评测折算的综合比较指数，不是答题正确率，也不表示所有任务的绝对能力。具体用途请结合分项原始成绩和运行配置。</p>
      </section>

      <ol id="rules-steps" className="mt-8 grid scroll-mt-[calc(var(--bar-h)+1.5rem)] gap-x-10 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        {STEPS.map((s) => (
          <li key={s.n} className="border-b border-line py-5">
            <span className="mono text-[11px] text-ink-4">{s.n}</span>
            <h2 className="mt-2 text-[15px] font-bold text-ink">{s.title}</h2>
            <p className="mt-1.5 text-[13px] leading-[1.8] text-ink-3">{s.body}</p>
          </li>
        ))}
      </ol>

      <section id="rules-budgets" className="mt-12 scroll-mt-[calc(var(--bar-h)+1.5rem)]">
        <Eyebrow>A BALANCED VIEW</Eyebrow>
        <h2 className="mt-2 text-[20px] font-bold text-ink">八个能力维度，各占相同份额。</h2>
        <p className="mt-1.5 max-w-[64em] text-[13px] leading-[1.8] text-ink-3">
          编程、数学与推理、知识与事实、语言理解与指令、写作与表达、视觉理解、专业任务、中文与多语言各占 12.5%。这是均衡取向的公开选择，不是通用能力的天然权重。每个维度先分配题族份额，再处理题族内的评测；同题重复不会增加总权重。已采用分项时，包含它们的综合指标不再重复计入。缺失份额不转给其他证据。
        </p>
        <ul className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-label="证据预算分配">
          {budgets.map((b) => (
            <li key={b.key} className="card flex flex-col p-4 lg:p-5">
              <span className="flex items-baseline justify-between gap-2">
                <span className="text-[13.5px] font-semibold text-ink">{b.name}</span>
                <span className="mono text-[20px] font-medium text-ink">{pct(b.weight)}</span>
              </span>
              <span className="mt-2.5 text-[11.5px] leading-[1.7] text-ink-4">{b.sources.length ? `本轮参与：${b.sources.join(" · ")}` : "本轮暂无可计入证据"}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 max-w-[64em] text-[12.5px] leading-[1.8] text-ink-3">
          编程、推理、知识、专业办公四类榜单保留独立入口，只比较对应能力的公开成绩；分类评分与参考位次不能跨分类比较。公开评测来自同一机构时，不能当成多个独立机构。更多评测只有补充不同的有效证据才有价值，数量本身不增加某个能力维度的总份额。
        </p>
      </section>

      <section id="rules-faq" className="mt-12 scroll-mt-[calc(var(--bar-h)+1.5rem)]">
        <h2 className="text-[20px] font-bold text-ink">你可能还想知道</h2>
        <div className="mt-3 border-t border-line">
          {FAQ.map((f) => (
            <Disclosure key={f.q} summary={f.q}>
              {f.a}
            </Disclosure>
          ))}
        </div>
      </section>

      <section id="rules-details" className="mt-10 scroll-mt-[calc(var(--bar-h)+1.5rem)] border-t border-line">
        <Disclosure summary="查看计算细节与当前版本">
          <div className="space-y-3">
            <p>
              方法版本：<code className="mono rounded-mark bg-bg-sunk px-1.5 py-0.5 text-[12px] text-ink-2">{run.methodologyVersion}</code>。模型身份、代表配置、题族归属、维度权重、参照组与计算输入均保留版本。参考顺序采用加权不完整 Kemeny 排序，最小化与共同评测相对成绩差的冲突；只发布求解达到最优且满足资格与连通条件的结果。可能存在多个同样最优的顺序，固定展示顺序不代表已精确分开所有型号，数学求解最优也不代表真实能力顺序已获证明。
            </p>
            <p>
              每项评测先确认协议和方向，再以固定参照组在同协议下的四分位距（中间一半参照成绩的跨度）校准连续分差。参照不是当前参榜模型的动态最高分或最低分；新增极端成绩不会因此重新拉伸其他模型的尺度。至少有四个有效参照且四分位距大于零才可校准；不足时等待有效参照。方向统一后的原始分差除以冻结的四分位距，再截断到 −1 至 1。它是相对成绩差，不是天然能力单位。
            </p>
            <p>
              评分在参考顺序确定后拟合：对每对共同评测的型号，以共同证据份额 W 加权，让分数差尽量接近标准化的平均成绩差 d，最小化 Σ W·(xᵢ−xⱼ−dᵢⱼ)²；同时约束 x 不与已发布顺序反向。本轮有效参照型号的 x 均值固定为 0，再按 100 / (1 + 9⁻ˣ) 映射为 0–100 分，参照中心为 50、相差一个拟合单位对应 90 或 10。这个尺度是公开约定，不是测得的概率。不同分类、轮次及方法版本不直接比较；新增有效证据或参评型号可改变拟合分数，筛选页面不会重新计算。
            </p>
            <p>
              加权拟合借鉴 <a href="https://arxiv.org/abs/0811.1067" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">HodgeRank 的成对比较思路</a>，本榜额外约束分数顺序。它会压缩冲突，不能把全部任务表现保真地浓缩成一个数字。拟合结果、实际参照和残差随计算轮次保存，未达到有效求解条件时不发布新轮次。
            </p>
            <p>
              标准误已公开时保留其误差信息；未公开时保留未知，不设为零，也不把标准化分差说成概率。缺测不补零、不补均值；共同证据不足或不连通时，不强行编造跨组的确定顺序。覆盖比例表示已覆盖的评测权重，不能解释成对最终参考位次的精确贡献率。
            </p>
            <p>
              综合榜至少需要三个来源、三个题族、三家机构、三个能力领域，并与至少两个固定参照有直接可比成绩。分类按其可用来源要求最多两项来源和两家机构、至少一个参照。发布超过十八个月的型号退出当前排序，已有详情页保留注明时间的历史记录。
            </p>
            <p>
              没有逐题数据时不能把展开的模型对数量当成独立样本量。已公开的成绩不涵盖所有可能偏差，也不能替代对未知成绩的研究。评分不附带未经验证的统计置信度。
            </p>
            <p>
              固定参照型号：<span className="mono text-[12px] text-ink-2">{anchors.join("、")}</span>。参照组用于校准评测尺度，不指定任何厂商应排第几。与评测协议一起冻结并保留版本，协议变化时重新核验。
            </p>
          </div>
        </Disclosure>
      </section>

      <Link viewTransition to="/leaderboard/sources" className="mt-8 inline-flex items-center gap-1 text-[13.5px] font-medium text-accent hover:text-accent-ink">
        查看每一份评测证据 →
      </Link>
    </ReadingLayout>
    </>
  );
}
