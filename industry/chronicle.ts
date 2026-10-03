// 主题页“大事记”的行业规则。通用的几步在框架里（packages/backend/src/publication/topic-chronicle.ts）：
// 从近 12 个月已公开的精选里，按这里的规则定类型，比精选分门槛，把同一件事并成一个节点，按每月名额取舍，
// 再写成事件名；公司主题只收这家公司自己的（看事实主体，没有主体时看标题在发布动作之前先点名谁）。
// 换行业时改这个文件：节点类型（名称、门槛、名额、画在哪一行）、内容形态主题收哪些类型、发布动作、
// 一篇报道算哪类节点。合并同一发布、写事件名两项可选，删掉就用框架的做法：只合并标题或事件名相同的，
// 事件名取标题的第一句。
// 公司编年史还可以接上人工整理的历史：industry/chronicles/{主题 slug}.json，格式见 docs/customize.md。

/** 主题的分组（topics.json 的 group）：公司、方向、内容形态。 */
type Group = "company" | "field" | "genre";

/** 一类节点。 */
export interface ChronicleKind {
  /** 卡片和时间轴上的类型名。 */
  label: string;
  /** 公司编年史里排在时间轴上方一行（AI：模型），标记最醒目；其余类型在下方一行。 */
  above?: true;
  /** 主题自己推出的东西（AI：模型、产品），用强调色标记；公司主题只收这家公司自己发布的。其余类型算新闻，公司主题只收以这家公司为主体的。 */
  launch?: true;
  /** 公司主题收这类节点的精选分门槛和每月名额（各类型分开取，互不挤占）；不写就不收。 */
  company?: { min: number; perMonth: number };
  /** 方向和形态主题收这类节点的精选分门槛（这些主题每月按重要程度取前 5 件）；不写就不收。 */
  other?: { min: number };
}

/** 规则读到的一篇入选报道。 */
export interface ChronicleItem {
  title: string;
  /** 外文报道的原标题。 */
  originalTitle: string | null;
  category: string | null;
  tags: string[];
  /** 属于这个行业最受关注的那类发布（taxonomy.ts 的 RELEASE）。 */
  release: boolean;
  /** 结构化抽取出的事实动作，比如 launch、opinion。 */
  factAction: string | null;
}

/** 一个候选节点：代表报道、事件名和它的全部报道。 */
export interface ChronicleEvent {
  kind: string;
  label: string;
  head: { title: string };
  reports: ReadonlyArray<{ title: string }>;
}

export interface ChronicleRules {
  /** 节点类型。公司主题的搜索摘要按这里的先后列出。 */
  kinds: Record<string, ChronicleKind>;
  /** 内容形态主题的大事记收哪些类型，每月最多几件（默认 5）；没列出的形态主题不设大事记，直接读精选。 */
  forms: Record<string, { kinds: string[]; perMonth?: number }>;
  /** 发布动作。公司主题遇到没有事实主体的报道，看标题在它之前先点名的是哪家公司。 */
  launchVerb: RegExp;
  /** 一篇报道在这一组主题里算哪类节点；不论分数高低都不算节点时返回 null（预告、教程、平台上架……）。 */
  kindOf(item: ChronicleItem, group: Group): string | null;
  /** 可选：同一周、同一类型的两个节点是不是同一件事（归组漏掉的同一发布）。 */
  sameEvent?(a: ChronicleEvent, b: ChronicleEvent): boolean;
  /** 可选：节点在时间轴上的名字（“Claude Opus 5.5 发布”），由代表报道的标题得出。 */
  eventName?(title: string, kind: string, topic: { slug: string; orgNames: readonly string[] }): string;
}

// ── 哪些报道算节点 ──────────────────────────────────────────────────────────────────────

const RELEASED = "发布|推出|上线|开源|亮相|登场|开放|升级|更新|launch|releas|introduc";
const SERVING = "(?<![A-Za-z])(?:OpenRouter|Fireworks|硅基流动|SiliconFlow|Together|Foundry|Hugging\\s?Face|Cloudflare|vLLM|SGLang|Ollama|LM\\s?Studio|llama\\.cpp|Modal|Groq|Cerebras|Baseten|Replicate|Bedrock|Vertex|Azure|AWS|Google Cloud|GitHub Copilot|Snowflake|Databricks|Perplexity|Poe|Unsloth)(?![A-Za-z])";
/** 讲的是模型或产品，但不是它的发布。 */
const NOT_A_LAUNCH = [
  /即将|预告|下周|将于|将[^，,。；;]{0,8}(?:发布|上线|推出|开源)|曝光?|传闻|coming soon/i, // 还没出
  /^(?:用|使用)[^，,。；;：:]{1,40}(?:构建|搭建)|^(?:教程|指南|实测|体验|复盘|如何|评测|跑分|排行榜|榜单)|^[^，,：:（(]{1,50}(?:教程|指南|评测)[：:]|[？?]$|技术报告(?:$|[：:（(])/, // 讲怎么用、怎么看
  new RegExp(`^(?!.*(?:${RELEASED})).*(?:登顶|榜首|夺冠|排名第|位列|SOTA|跑分)`, "i"), // 只有排名，没有发布
  new RegExp(`^(?!.*(?:${RELEASED})).*(?:登陆|上架|接入)`, "i"), // 到了别的平台
  /限时|再度免费|免费开放/, // 优惠活动
  /等\s?\d+\s?余?项|一揽子|多项(?:新)?(?:更新|功能)|(?:发布|更新)亮点|汇总|合集|盘点/, // 合集
  /日零支持|首日支持|\bday[- ]?(?:0|zero)\b|GGUF/i, // 支持运行它
  /^(?:Show|Ask) HN|开源实现|复现/i, // 别人做的
];
/** 托管平台上架一个模型（“OpenRouter 上线 GPT-8”），不是平台自己的发布。 */
const LISTED = new RegExp(`^${SERVING}[^，,。；;]{0,12}(?:上线|上架|接入|支持|部署)`, "i");
/** 被带到托管平台上：不是这家公司自己的发布。 */
const HOSTED = new RegExp(`(?:上线|登陆|上架|接入|支持).*${SERVING}|\\b(?:live|available|launch(?:es|ed)?)\\s+on\\s+${SERVING}`, "i");
const COMMENTARY_ACTION = /^(?:opinion|analysis|commentary|prediction|tutorial|介绍|讲解|分享|评测|测评|回顾|复盘)(?:\b|功能|方法|$)/i;

/** 产品、模型发布、研究和行业新闻是节点；公司主题里的行业新闻是这家公司的大事。 */
function kindOf(item: ChronicleItem, group: Group): string | null {
  const kind = item.category === "ai-products" ? "product" : item.release ? "model" : item.category === "paper" ? "research"
    : item.category === "industry" ? (group === "company" ? "company" : "industry") : null;
  if (kind !== "model" && kind !== "product") return kind;
  if (NOT_A_LAUNCH.some((p) => p.test(item.title)) || (LISTED.test(item.title) && modelNames(item.title).length > 0)
    || COMMENTARY_ACTION.test(item.factAction ?? "")) return null;
  return group === "company" && HOSTED.test(`${item.title} ${item.originalTitle ?? ""}`) ? null : kind;
}

// ── 同一个模型 ──────────────────────────────────────────────────────────────────────────

/**
 * 标题讲的是哪些模型，写成系列加版本，点名了变体时带上变体："GPT-5.5" gpt5.5、"GPT-5.5 Instant"
 * gpt5.5:instant、"Qwen3.8-Flash" qwen3.8:flash、"DeepSeek-V4.1" v4.1、"Kimi K3" k3。尺寸（35B、1M）和年份不是版本，
 * 拿来比较的模型不是它讲的模型。
 */
const VERSION = /(?<![A-Za-z0-9])([A-Za-z]{1,12})[-\s]?(\d{1,2}(?:\.\d{1,3}){0,2})(?:[a-z](?![A-Za-z0-9]))?(?![A-Za-z0-9.])(?:[-\s]([A-Z][A-Za-z]+))?/g;
const COMPARED = /(?:接近|击败|超越|超过|对标|比肩|媲美|胜过|逼近|追平|领先|较|相比|对比|\bvs\.?|\bbeats?)[^，,。；;：:]*|与[^，,。；;：:]{1,30}(?:持平|相当|媲美|齐平|看齐)/gi;
/** 发布阶段和普通单词不是变体。 */
const STAGE = /^(?:Preview|Beta|Alpha|Exp|Experimental|Release|API|Model|Models|Series|And|On|For|With|In|Is|Now)$/i;
function modelNames(title: string): string[] {
  return [...new Set([...title.replace(COMPARED, " ").matchAll(VERSION)].map(([, family, version, variant]) =>
    `${family!.toLowerCase()}${version}${variant && !STAGE.test(variant) ? `:${variant.toLowerCase()}` : ""}`))];
}
/** 系列和版本相同，变体相同或有一方没写变体。 */
const sameModel = (a: string[], b: string[]) => a.some((x) => b.some((y) => {
  const [fx, vx] = x.split(":");
  const [fy, vy] = y.split(":");
  return fx === fy && (!vx || !vy || vx === vy);
}));
/** 指一档模型而不是一个模型的变体（“Flash”），和代号（“Astra”）不同。 */
const TIER = /^(?:flash|pro|max|mini|lite|plus|nano|turbo|ultra|instant|live|thinking|code|coder|vision|omni|air|edge|super|fast|large|small|medium|base|chat|next|audio|image|video|voice|tts|realtime|cyber|speciale)$/;
/** 没写版本的标题点名了另一篇的代号（“新模型 Astra”和“GPT-6 Astra”）。 */
const byCodename = (title: string, models: string[]) => models.some((m) => {
  const variant = m.split(":")[1];
  return !!variant && !TIER.test(variant) && new RegExp(`(?<![A-Za-z])${variant}(?![A-Za-z])`, "i").test(title);
});
const plain = (title: string) => title.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

/** 一个节点的报道点名的全部型号：合并时每个节点要和前一周的节点逐个比，所以每个节点只算一次。 */
const eventModels = new WeakMap<ChronicleEvent, string[]>();
function modelsOf(e: ChronicleEvent): string[] {
  let models = eventModels.get(e);
  if (!models) eventModels.set(e, (models = [...new Set(e.reports.flatMap((r) => modelNames(r.title)))]));
  return models;
}

/** 事件名去掉发布动作后相同（“Muse Glimmer 开源”和“Muse Glimmer 发布”）；模型还看型号，或只写代号的后续报道。 */
function sameEvent(a: ChronicleEvent, b: ChronicleEvent): boolean {
  if (plain(unlaunched(a.label)) === plain(unlaunched(b.label))) return true;
  if (a.kind !== "model") return false;
  const [x, y] = [modelsOf(a), modelsOf(b)];
  return sameModel(x, y) || (x.length === 0 && byCodename(a.head.title, y)) || (y.length === 0 && byCodename(b.head.title, x));
}

// ── 事件名 ──────────────────────────────────────────────────────────────────────────────
// 大事记写事件名（“Claude Opus 5.5 发布”“推出 ChatGPT Work”），新闻标题留给报道本身。

/** 标题第一个分句在哪里结束：逗号（数字里的不算）、冒号、分号、句号、破折号或竖线。 */
const CLAUSE = /[，：；。！？｜|]|(?<!\d),|,(?!\d)|[:;!?](?=\s|$|\p{Script=Han})|——|\s[-—–]\s/u;
/** 新闻和研究保留冒号后面的说明（“OSWorld 3：长时域…基准”），逗号仍然断句。 */
const SENTENCE = /[，；。！？]|(?<!\d),|,(?!\d)|[;!?](?=\s|$|\p{Script=Han})/u;
const LAUNCH_VERB = "(?:正式|全面|重磅|首次|同步)?(?:发布并开源|发布|推出|上线|开源|亮相|登场|开放|预览)";
/** 以动作开头的标题（“推出 X”“介绍 X”）。 */
const LEADING_VERB = new RegExp(`^(介绍|${LAUNCH_VERB})\\s*(.+)$`, "u");
/** 发布的东西在第二个动作开始的地方结束（“X 并开放 Y”）。 */
const SECOND_ACTION = /并|同时/u;
const LATIN = "[\\p{Script=Latin}\\d][\\p{Script=Latin}\\d.+_/\\p{Pd}]*";
/** 拉丁字母的名字和连接它们的词，可带发布阶段：“Claude Fable 5.1 与 Claude Mythos 5.1”“Grok Imagine 1.5 预览版”。 */
const NAME_RUN = new RegExp(`${LATIN}(?:\\s*(?:与|和|及|、|&)\\s*${LATIN}|\\s+${LATIN})*(?:\\s*(?:预览版|正式版|测试版|公测版|开源版))?`, "gu");
/** 只有拉丁字母的名字（连接词不算）。 */
const BARE = /^[\p{Script=Latin}\d\s.+_/·&'’\p{Pd}]+$/u;
const bare = (c: string) => BARE.test(c.replace(/和|与|及|、/gu, " "));
const ORG_SUFFIX = "(?:\\s*(?:Labs?|Research|AI|Team|团队|官方))?";
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const named = (c: string) => modelNames(c).length > 0;
/** 说了发布了什么（“开放平台”是一种平台，不是开放）。 */
const launched = (c: string) => /发布|推出|上线|开源|亮相|登场|升级|更新|launch|releas|introduc/i.test(c);
/** “Gemini 4” 加“发布”中间空格，“智能体平台”加“发布”不空格。 */
const joined = (a: string, b: string) => (/[\p{Script=Latin}\d).]$/u.test(a) ? `${a} ${b}` : `${a}${b}`);
/** 产品发布的名字在介绍它能做什么之前结束（“网页桥接扩展 支持多平台交互”）。 */
const DESCRIBED = /\s+(?=支持|可|实现|提供|让|帮助|助力|面向|用于|主打|覆盖)/u;

type Topic = { slug: string; orgNames: readonly string[] };
const companyForms = new Map<string, { says: RegExp; plans: RegExp; opens: RegExp } | null>();
/** 公司自己的公告（“<它> 发布 X”）和以它的名字开头的说法。 */
function ownForms(t: Topic) {
  if (!companyForms.has(t.slug)) {
    const names = [...t.orgNames].sort((a, b) => b.length - a.length).map(escape).join("|");
    companyForms.set(t.slug, names ? {
      says: new RegExp(`^(${names})${ORG_SUFFIX}\\s*(${LAUNCH_VERB})\\s*(.+)$`, "u"),
      plans: new RegExp(`^(?:${names})${ORG_SUFFIX}\\s*将\\s*`, "u"),
      opens: new RegExp(`^(?:${names})${ORG_SUFFIX}(?:\\s*[：:]\\s*|\\s+|(?=\\p{Script=Han}))`, "u"),
    } : null);
  }
  return companyForms.get(t.slug)!;
}

/** 发布的东西里的模型名：带版本的拉丁字母名字，或两个大写开头的词（“Muse Glimmer”）。 */
function modelName(what: string): string | null {
  for (const m of what.matchAll(NAME_RUN)) {
    const run = m[0].trim();
    if (named(run) || /[A-Z][\p{L}\d]*[\s\p{Pd}]+[A-Z]/u.test(run)) return run;
  }
  return null;
}
/** 去掉发布动作的事件名：“Muse Glimmer 开源”和“Muse Glimmer 发布”是同一个模型。 */
const unlaunched = (label: string) => label.replace(new RegExp(`\\s*(?:开源|发布|推出|上线)*${LAUNCH_VERB}$`, "u"), "");

/** 在公司自己的主题页上，名字去掉公司（“NVIDIA Nemotron 3”写成“Nemotron 3”），除非公司名就是系列名（“DeepSeek V4”）。 */
function withoutCompany(t: Topic, name: string): string {
  const opening = ownForms(t)?.opens.exec(name);
  const rest = opening ? name.slice(opening[0].length).trim() : "";
  return rest && !/^[A-Za-z]{1,2}\d/.test(rest) ? rest : name;
}

/** 说出事件的那个分句：跳过冒号前的标签或说话人（“Dreaming:”“谷歌：”），或产品名后面的口号。 */
function namingClause(title: string, kind: string): string {
  const [first = title, next] = title.split(CLAUSE).map((c) => c.replace(/\s*[（(][^（）()]*[）)]\s*$/u, "").trim()).filter(Boolean);
  // 接着上一句往下说的分句（“并推出 Docs”）自己说不出事件。
  const second = next && !/^(?:并|且|还|同时|以|为|由|但|而)/u.test(next) ? next : undefined;
  if (kind === "model") {
    const name = (c: string) => bare(c) && !/\d{4}/.test(c);
    return launched(first) || named(first) || name(first) ? first : second && (launched(second) || named(second)) ? second : title.trim();
  }
  if (kind === "product") return launched(first) || !second || !launched(second) ? first : second;
  return title.split(SENTENCE)[0]!.trim();
}

/** 事件名，名字在前：“Claude Opus 5.5 发布”“ChatGPT Work 推出”；在公司自己的主题页上不写公司。 */
function eventName(title: string, kind: string, t: Topic): string {
  const clause = namingClause(title, kind);
  const forms = ownForms(t);
  const own = forms?.says.exec(clause);
  const lead = own ? null : LEADING_VERB.exec(clause);
  const verb = own?.[2] ?? (lead?.[1] === "介绍" ? "发布" : lead?.[1]);
  const what = (own?.[3] ?? lead?.[2])?.split(SECOND_ACTION)[0]?.trim();
  if (kind === "model") {
    if (verb && what) {
      const name = modelName(what);
      const org = own?.[1];
      return joined(!name ? what : org && /^[A-Za-z]{1,2}\d/.test(name) ? `${org} ${name}` : withoutCompany(t, name), verb);
    }
    const alone = withoutCompany(t, clause);
    return !launched(alone) && bare(alone) && !/\d{4}/.test(alone) ? joined(alone, "发布") : alone;
  }
  if (kind === "product") {
    if (own && verb && what) return joined(what.split(DESCRIBED)[0]!, verb);
    const plan = forms?.plans.exec(clause);
    if (plan) return clause.slice(plan[0].length);
    return !launched(clause) && bare(clause) ? joined(clause, "发布") : clause;
  }
  const opening = kind === "company" ? forms?.opens.exec(clause) : null;
  const rest = opening ? clause.slice(opening[0].length).trim() : "";
  return [...rest].length >= 4 ? rest : clause;
}

export const CHRONICLE: ChronicleRules = {
  kinds: {
    model: { label: "模型", above: true, launch: true, company: { min: 70, perMonth: 3 }, other: { min: 75 } },
    product: { label: "产品", launch: true, company: { min: 75, perMonth: 2 }, other: { min: 75 } },
    research: { label: "研究", other: { min: 75 } },
    company: { label: "公司", company: { min: 85, perMonth: 1 } },
    industry: { label: "行业", other: { min: 85 } },
  },
  forms: {
    "model-releases": { kinds: ["model"], perMonth: 8 },
    "product-updates": { kinds: ["product"] },
    papers: { kinds: ["research"] },
    benchmarks: { kinds: ["research", "product"] },
    industry: { kinds: ["industry"] },
    policy: { kinds: ["industry"] },
  },
  launchVerb: new RegExp(RELEASED, "i"),
  kindOf,
  sameEvent,
  eventName,
};
