// Topic milestones: the rules in publication/topic-chronicle.ts with the AI pack's industry/chronicle.ts,
// on reports as the topic index reads them. Written before the code, from the ways it can go wrong:
// - kinds: a company's month is filled by one kind, so its models crowd out its products or industry
//   news displaces both; news about several companies (a third-party report) shows as one company's own;
// - not a launch: an announcement of what is coming, a rumour, a tutorial, a question-titled
//   explainer, a technical report, ranking news without a release, a limited-time offer, a roundup of
//   twenty updates, a serving platform's listing (OpenRouter, vLLM day-0 support, GGUF builds, 登陆
//   Copilot), Show HN or somebody else's reimplementation counts as a launch, or an untranslated
//   English post becomes a milestone's title; while a lab's own open release that also lands on
//   Hugging Face loses its place in technical topics;
// - ownership: a company takes a launch whose title names another company first, or one that only
//   its source owns (a community model announced on the Hugging Face blog);
// - one event: reports of one model release within a week (separate facts, a preview and the family
//   launch, a Chinese and an English post, a follow-up naming it by codename) stay several milestones;
//   or two models merge: a tier word taken for a codename, another
//   version (GPT-7 and GPT-7.1), a variant launched on its own (Gemini 9 Flash, Gemini 9 Live), a
//   model named only to compare with ("接近 GPT-7 Astra"), the same family weeks apart; the merged
//   event takes a later date, or a weaker or English headline although a Chinese one exists;
// - curated history: an older, stronger report in a month a company's curated history covers
//   suppresses the event's automatic milestone after that month;
// - directions: a direction's chronicle fills with general releases that carry its tag but do not
//   name it in the title;
// - limits: the model timeline keeps no more of a busy month than any other topic; the search
//   snippet's highlights put company news before the company's models;
// - labels (the chronicle names its events, "Claude Opus 5.5 发布", not the news headline): a label
//   keeps the headline's claims after its first clause, or loses the model's name; on a company's
//   page every label repeats the company ("Anthropic 发布…"), or a product name that opens the
//   headline ("Claude Code", "ChatGPT") is dropped as if it were the company, or a model loses the
//   family name the company gives it ("DeepSeek 发布 V9" is "DeepSeek V9 发布"); other topics drop the
//   company, so a model's owner is lost; a model named without a verb stays a bare name, or 发布 is
//   added to a clause that already says what happened ("重新部署 Claude Fable 5"); a tag before a
//   colon ("Dreaming:", a speaker's "谷歌：") or an event's name ("I/O 2026") becomes the label, while
//   a product named before its tagline ("MiniMax Agent Team：为…而生") loses its name; a model keeps the
//   claims that follow its name ("GPT-5.5-Cyber 在 CyberGym 击败…", "…并开放 API 公测"), or a lone
//   Latin word drops what it is ("MSA 稀疏注意力方法"); a clause opening with 并 is taken for the event;
//   research or news loses what follows its colon ("OSWorld 3：长时域…基准"); "开放平台" reads as a launch;
//   two reports of one version-less model stay two identical milestones; a number's comma ("1,000")
//   cuts the clause.
import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { findTopic, TOPICS } from "@aihot/backend/publication/topics";
import { selectTopicChronicle, selectTopicHighlights, type ChronicleReport } from "@aihot/backend/publication/topic-chronicle";

const NOW = new Date("2026-09-30T20:00:00+08:00");
const window = { now: NOW };
const ALL = TOPICS.map((t) => t.slug);
const topic = (slug: string) => {
  const t = findTopic(slug);
  assert.ok(t, slug);
  return t;
};

let n = 0;
/** A selected report, on 10 September unless `day` says otherwise. */
function report(title: string, o: Partial<ChronicleReport> & { day?: number } = {}): ChronicleReport {
  n += 1;
  const at = new Date(`2026-09-${String(o.day ?? 10).padStart(2, "0")}T12:00:00+08:00`);
  return {
    id: `r${n}`, title, originalTitle: null, category: "ai-models", tags: ["模型发布"], score: 85, topicSlugs: ALL,
    timelineAt: at, publishedAt: at, factPublishedAt: null, firstParty: false, owner: null, factId: null, factSubject: null,
    factAction: null, factOccurredAt: null, storyPublicId: null, sourceCount: 1, scope: "single", ...o,
  };
}
const product = (title: string, o: Partial<ChronicleReport> & { day?: number } = {}) => report(title, { category: "ai-products", tags: ["产品更新"], ...o });
const news = (title: string, o: Partial<ChronicleReport> & { day?: number } = {}) => report(title, { category: "industry", tags: ["行业动态"], ...o });
const events = (slug: string, reports: ChronicleReport[]) => selectTopicChronicle(topic(slug), reports, window).flatMap((m) => m.events);
const titles = (slug: string, reports: ChronicleReport[]) => events(slug, reports).map((e) => e.title);

test("a company's month keeps three models, two products and one piece of its own news, each by score", () => {
  const reports = [
    report("OpenAI 发布 GPT-7", { score: 90 }), report("OpenAI 发布 GPT-7 mini", { score: 85, day: 20 }),
    report("OpenAI 发布语音模型 Voice 3", { score: 80 }), report("OpenAI 发布图像模型 Images 4", { score: 75 }),
    product("ChatGPT 推出记忆功能", { score: 85 }), product("Codex 推出云端任务", { score: 80 }), product("ChatGPT 上线群聊", { score: 76 }),
    product("ChatGPT 新增目录导航", { score: 74 }),
    news("OpenAI 完成新一轮融资", { score: 98, tags: ["行业动态", "entity:openai"] }), news("OpenAI 任命新首席财务官", { score: 97, tags: ["行业动态", "entity:openai"] }),
    news("OpenAI 发布年度报告", { score: 84, tags: ["行业动态", "entity:openai"] }),
  ];
  const picked = events("openai", reports);
  const of = (kind: string) => picked.filter((e) => e.kind === kind).map((e) => e.title).sort();
  assert.deepEqual(of("model"), ["OpenAI 发布 GPT-7", "OpenAI 发布 GPT-7 mini", "OpenAI 发布语音模型 Voice 3"].sort());
  assert.deepEqual(of("product"), ["ChatGPT 推出记忆功能", "Codex 推出云端任务"].sort());
  assert.deepEqual(of("company"), ["OpenAI 完成新一轮融资"]);
  assert.deepEqual(picked.map((e) => e.at), [...picked].sort((a, b) => b.at.localeCompare(a.at)).map((e) => e.at), "newest first within the month");
});

test("what is not a launch stays out, however high its score", () => {
  const out = [
    "OpenAI 即将发布 GPT-8", "OpenAI 将于下周推出 GPT-8", "OpenAI 评定 GPT-8 达到高风险阈值，将受限发布", "曝 OpenAI GPT-8 下月发布",
    "如何用 GPT-8 构建应用", "GPT-8 为什么更聪明？", "GPT-8 技术报告", "GPT-8 登顶 Arena 榜首", "ChatGPT 限时免费开放 GPT-8",
    "OpenAI DevDay 发布 GPT-8、常驻智能体等 20 余项更新", "OpenRouter 上线 OpenAI GPT-8", "OpenAI GPT-8 获 vLLM 日零支持",
    "OpenAI GPT-8 GGUF 量化版发布", "GPT-8 正式登陆 GitHub Copilot", "Show HN: 用 OpenAI GPT-8 写的终端工具", "GPT-8 的开源实现",
    "Major ChatGPT upgrade rolling out now, in the form of GPT-8:",
  ];
  const reports = out.map((title, i) => report(title, { score: 99, day: 1 + i }));
  assert.deepEqual(titles("openai", reports), []);
  assert.deepEqual(titles("model-releases", reports), [], "nor on the model timeline");
  const launch = report("OpenAI 发布 GPT-8，登顶多项榜单", { score: 99, day: 25 });
  assert.deepEqual(titles("openai", [...reports, launch]), [launch.title], "a launch may claim its rankings");
});

test("a lab's own open release that lands on a platform is not the platform's, but stays a launch elsewhere", () => {
  const release = report("AntLingAGI 开源 Ling-9 智能体模型，登陆 Hugging Face 平台", { factSubject: "AntLingAGI", tags: ["模型发布", "Agent", "entity:hugging-face"], owner: "hugging-face" });
  assert.deepEqual(titles("hugging-face", [release]), []);
  assert.deepEqual(titles("agent", [release]), [release.title]);
  assert.deepEqual(titles("model-releases", [release]), [release.title]);
});

test("a company's launch names the company first, or the company is the fact's subject", () => {
  const extension = product("马斯克 SpaceXAI 为微软 Office 推出 Grok 扩展");
  assert.deepEqual(titles("xai", [extension]), [extension.title]);
  assert.deepEqual(titles("microsoft", [extension]), [], "Microsoft is only named after xAI");
  const community = report("Holo9：快速本地计算机使用模型", { owner: "hugging-face", tags: ["模型发布", "entity:hugging-face"] });
  assert.deepEqual(titles("hugging-face", [community]), [], "announced on its blog, not its model");
  const joint = report("Cursor 与 SpaceXAI 联合发布 Grok 9", { factSubject: "Cursor、SpaceXAI" });
  assert.deepEqual(titles("cursor", [joint]), [joint.title]);
  assert.deepEqual(titles("xai", [joint]), [joint.title], "both subjects");
});

test("company news is the company's own: its subject, or the only company it is about", () => {
  const probe = news("澳大利亚将调查 OpenAI 模型入侵政府网站", { score: 90, factSubject: "澳大利亚", tags: ["行业动态", "entity:openai"] });
  const report2 = news("英国 AISI 报告评测中出现未授权行为，涉及 Anthropic 与 OpenAI 模型", { score: 90, tags: ["行业动态", "entity:anthropic", "entity:openai"] });
  const deal = news("NVIDIA 宣布收购 Hugging Face", { score: 90, factSubject: "NVIDIA、Hugging Face", tags: ["行业动态", "entity:nvidia", "entity:hugging-face"] });
  assert.deepEqual(titles("openai", [probe, report2]), [probe.title]);
  assert.deepEqual(titles("anthropic", [report2]), []);
  assert.deepEqual(titles("hugging-face", [deal]), [deal.title]);
  assert.deepEqual(events("nvidia", [deal]).map((e) => e.kind), ["company"]);
});

test("one model's reports within a week are one milestone: the earliest date, the strongest Chinese headline", () => {
  const reports = [
    report("未来的标志：GPT-7", { day: 11, score: 77, sourceCount: 3 }),
    report("GPT-7 正式发布", { day: 12, score: 90, factId: 1 }),
    report("GPT-7", { day: 13, score: 99, factId: 2 }),
    report("OpenAI 发布 GPT-7 Pro", { day: 14, score: 80, storyPublicId: "s-1" }),
  ];
  const picked = events("openai", reports);
  assert.equal(picked.length, 1);
  assert.equal(picked[0]!.title, "GPT-7 正式发布", "a Chinese headline before a higher score");
  assert.equal(picked[0]!.at.slice(0, 10), "2026-09-11");
  assert.equal(picked[0]!.kind, "model");
});

test("curated months cannot suppress an event's automatic milestone after the curated boundary", () => {
  const august = new Date("2026-08-20T12:00:00+08:00");
  const older = report("MiniMax 发布 M9", { storyPublicId: "s-curated", score: 95, timelineAt: august, publishedAt: august });
  const newer = report("MiniMax 发布 M9 Pro", { storyPublicId: "s-curated", score: 80 });
  const picked = selectTopicChronicle(topic("minimax"), [older, newer], { now: NOW, through: "2026-08" }).flatMap((m) => m.events);
  assert.deepEqual(picked.map((e) => [e.title, e.at.slice(0, 10)]), [[newer.title, "2026-09-10"]], "automatic selection starts after the curated month, before event deduplication");
});

test("a report naming a model only by its codename joins that model's launch of the same week", () => {
  const launch = report("OpenAI 发布 GPT-7 Astra：多项基准刷新纪录", { day: 3, score: 88 });
  const followUp = report("OpenAI 发布新模型 Astra，主打计算机操作", { day: 4, score: 81 });
  const tier = report("Google 发布 Gemini Omni Flash 视频模型", { day: 5 });
  const flash = report("Google 发布 Gemini 9 Flash", { day: 4 });
  assert.deepEqual(titles("model-releases", [followUp, launch]), [launch.title], "either order");
  assert.equal(events("google", [flash, tier]).length, 2, "a tier word such as Flash is not a codename");
});

test("different models stay apart: another version, a variant of its own, a comparison, weeks apart", () => {
  const pairs: Array<[string, string, ChronicleReport[]]> = [
    ["openai", "another version", [report("OpenAI 发布 GPT-7 Sol 和 GPT-7 Luna", { day: 20 }), report("OpenAI 发布 GPT-7.1 Sol，以五分之一价格接近 GPT-7 Astra", { day: 24 })]],
    ["google", "a variant of its own", [report("Google DeepMind 发布 Gemini 9 Flash", { day: 3 }), report("Google DeepMind 发布 Gemini 9 Live", { day: 8 })]],
    ["anthropic", "a model it is compared with", [report("Anthropic 发布 Claude Opus 9", { day: 5 }), report("Anthropic 发布 Claude Sonnet 9，成本较 Opus 9 降低 40%", { day: 6 })]],
    ["deepseek", "weeks apart", [report("DeepSeek-V9 预览版上线", { day: 2 }), report("DeepSeek-V9 正式版发布", { day: 20 })]],
  ];
  for (const [slug, why, reports] of pairs) assert.equal(events(slug, reports).length, 2, why);
});

test("a direction's chronicle takes what names the direction, not everything carrying its tag", () => {
  const general = report("Anthropic 发布 Claude Opus 9，成本降低 40%", { tags: ["模型发布", "Agent"] });
  const agentic = report("DeepSeek-V9-Pro 正式版上线，Agent 能力大幅增强", { tags: ["模型发布", "Agent"] });
  const benchmark = report("OSWorld 3：长时域计算机使用智能体基准", { category: "paper", tags: ["论文/研究", "Agent"] });
  const probe = news("澳大利亚将调查 OpenAI 模型入侵政府网站", { score: 90, tags: ["行业动态", "Agent"] });
  assert.deepEqual(new Set(titles("agent", [general, agentic, benchmark, probe])), new Set([agentic.title, benchmark.title]));
  assert.deepEqual(events("agent", [benchmark]).map((e) => e.kind), ["research"]);
});

test("the model timeline keeps eight launches of a busy month, other topics five", () => {
  const launches = Array.from({ length: 9 }, (_, i) => report(`Lab${i} 发布智能体模型 M${i + 1}`, { day: 1 + i * 3, score: 90 - i, tags: ["模型发布", "Agent"] }));
  assert.equal(events("model-releases", launches).length, 8);
  assert.equal(events("agent", launches).length, 5);
  assert.ok(!titles("model-releases", launches).includes(launches[8]!.title), "the least important one drops out");
});

test("a company's highlights lead with its models, then its products and news", () => {
  const reports = [news("OpenAI 完成新一轮融资", { score: 99, tags: ["行业动态", "entity:openai"], day: 25 }), product("ChatGPT 推出群聊", { score: 90, day: 26 }), report("OpenAI 发布 GPT-7", { score: 80, day: 27 })];
  assert.deepEqual(selectTopicHighlights(topic("openai"), reports, window).map((e) => e.kind), ["model", "product", "company"]);
});

test("a milestone reads as the event's name: the headline's first clause, the company left out on its own page", () => {
  const label = (slug: string, title: string, o: Partial<ChronicleReport> = {}) => events(slug, [report(title, o)]).map((e) => e.label)[0];
  const cases: Array<[string, string, string, Partial<ChronicleReport>?]> = [
    ["anthropic", "Anthropic 发布 Claude Opus 9.5，成本较 Opus 9 降低 40%", "Claude Opus 9.5 发布"],
    ["agent", "Anthropic 发布 Claude Opus 9.5 智能体模型，成本较 Opus 9 降低 40%", "Anthropic 发布 Claude Opus 9.5 智能体模型"],
    ["anthropic", "Anthropic 发布 Claude Fable 9.1 与 Claude Mythos 9.1", "Claude Fable 9.1 与 Claude Mythos 9.1 发布"],
    ["google", "Google DeepMind 发布 Gemini 9 Argon，面向可信网络防御者先行开放", "Gemini 9 Argon 发布"],
    ["kimi", "Kimi K9：智能的新前沿", "Kimi K9 发布"],
    ["anthropic", "Claude Fable 9 和 Claude Mythos 9", "Claude Fable 9 和 Claude Mythos 9 发布"],
    ["anthropic", "重新部署 Claude Fable 9", "重新部署 Claude Fable 9"],
    ["openai", "Dreaming: ChatGPT 推出更强的记忆系统，更好记住用户偏好", "ChatGPT 推出更强的记忆系统", { category: "ai-products", tags: ["产品更新"] }],
    ["anthropic", "Claude Code 推出 mods，可用 TypeScript 函数改写提示词", "Claude Code 推出 mods", { category: "ai-products", tags: ["产品更新"] }],
    ["openai", "OpenAI 推出 ChatGPT Work：可跨应用自主工作的 AI 智能体", "ChatGPT Work 推出", { category: "ai-products", tags: ["产品更新"] }],
    ["kimi", "Kimi推出网页桥接扩展 支持多平台交互", "网页桥接扩展推出", { category: "ai-products", tags: ["产品更新"] }],
    ["nvidia", "介绍 NVIDIA Nemotron 9 Nano Omni：面向文档的长上下文多模态模型", "Nemotron 9 Nano Omni 发布"],
    ["nvidia", "英伟达 Cosmos 9", "Cosmos 9 发布"],
    ["meta", "Meta 发布 Muse Spark 9.1 多模态推理模型并开放 Meta Model API 公测", "Muse Spark 9.1 发布"],
    ["openai", "OpenAI 发布 GPT-9.5-Cyber 在 CyberGym 击败 Mythos 9，扩大网络安全计划", "GPT-9.5-Cyber 发布"],
    ["openai", "OpenAI 预览新一代模型 GPT-9 Sol", "GPT-9 Sol 预览"],
    ["qwen", "Qwen-AgentWorld：面向通用智能体的语言世界模型", "Qwen-AgentWorld 发布"],
    ["minimax", "MiniMax Agent Team：为长期运行与持续演进而生", "MiniMax Agent Team 发布", { category: "ai-products", tags: ["产品更新"] }],
    ["cursor", "从任何地点构建——Cursor for iOS 公测版发布", "Cursor for iOS 公测版发布", { category: "ai-products", tags: ["产品更新"] }],
    ["google", "谷歌：Gemini App 月活超 9 亿同比翻倍，是其增长最快的产品之一", "Gemini App 月活超 9 亿同比翻倍", { category: "industry", tags: ["行业动态", "entity:google"] }],
    ["anthropic", "Anthropic 因盗版书籍支付 15 亿美元和解金，创下集体诉讼版权赔偿纪录", "因盗版书籍支付 15 亿美元和解金", { category: "industry", tags: ["行业动态", "entity:anthropic"] }],
    ["anthropic", "Anthropic 将 Claude Cowork 与聊天合并为统一 Claude，并推出 Docs 和 Slides", "Claude Cowork 与聊天合并为统一 Claude", { category: "ai-products", tags: ["产品更新"] }],
    ["agent", "Anthropic 将 Claude Cowork 与聊天合并为统一智能体，并推出 Docs", "Anthropic 将 Claude Cowork 与聊天合并为统一智能体", { category: "ai-products", tags: ["产品更新", "Agent"] }],
    ["minimax", "MiniMax 发布 MSA 稀疏注意力方法，开源推理内核", "MSA 稀疏注意力方法发布"],
    ["openai", "OpenAI ChatGPT 语音最大规模升级：双向AI语音模型已上线测试", "ChatGPT 语音最大规模升级"],
    ["deepseek", "DeepSeek 发布 V9.1-Flash，API 价格同步下调", "DeepSeek V9.1-Flash 发布"],
    ["xai", "xAI 发布 Grok Imagine 9.5 预览版（图像转视频模型）", "Grok Imagine 9.5 预览版发布"],
    ["google", "I/O 2026: 欢迎来到自主的 Gemini 时代", "I/O 2026: 欢迎来到自主的 Gemini 时代"],
    ["model-releases", "小米 MiMo-V9 突破 1,000 tokens/s，单节点运行 1T 模型", "小米 MiMo-V9 突破 1,000 tokens/s"],
    ["anthropic", "路透审阅 Anthropic IPO 招股书：收入增长 12 倍，估值或超 2 万亿美元", "路透审阅 Anthropic IPO 招股书：收入增长 12 倍", { category: "industry", tags: ["行业动态", "entity:anthropic"] }],
    ["agent", "OSWorld 3：长时域计算机使用智能体基准", "OSWorld 3：长时域计算机使用智能体基准", { category: "paper", tags: ["论文/研究", "Agent"] }],
    ["agent", "Cloudflare OS：面向代理、应用和智能体的开放平台", "Cloudflare OS 发布", { category: "ai-products", tags: ["产品更新", "Agent"] }],
  ];
  for (const [slug, title, expected, o] of cases) assert.equal(label(slug, title, o), expected, `${slug}: ${title}`);
  assert.equal(events("anthropic", [report("Anthropic 发布 Claude Opus 9.5，成本较 Opus 9 降低 40%")])[0]!.title, "Anthropic 发布 Claude Opus 9.5，成本较 Opus 9 降低 40%", "the headline itself is kept");
});

test("one model whose reports in a week name it the same way, without a version, is one milestone", () => {
  assert.deepEqual(events("meta", [report("Meta 开源 30B 模型 Muse Glimmer，18GB 内存即可本地运行", { day: 10 }), report("Meta 开源 Muse Glimmer，Apache 2.0 首秀", { day: 11 })]).map((e) => e.label), ["Muse Glimmer 开源"]);
  assert.equal(events("qwen", [report("Qwen-AgentWorld：面向通用智能体的语言世界模型", { day: 23 }), report("Qwen-AgentWorld 开源：让 Agent 学会先预测再行动", { day: 24 })]).length, 1);
  assert.equal(events("meta", [report("Meta 发布 Muse Spark 多模态推理模型", { day: 2 }), report("Meta 发布 Muse Spark 1.1 低价模型", { day: 5 })]).length, 2, "a version makes another model");
});
