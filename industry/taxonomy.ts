// OPCHOT 的行业分类体系：类别、标签词表、社区与机构名录。
// 换信源时优先改这里和 prompts/，代码基本不用动。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题；guide 告诉结构抽取模型这一类收什么、边界在哪。
 * commentary 标出评论类（观点、经验复盘）：出现过的事再评论，只占一行快讯。
 * tagColor 是飞书推送卡片里这一类小标签的颜色（飞书 text_tag 的颜色名）。
 */
export const CATEGORIES = [
  { key: "community", tagColor: "turquoise", label: "社区动态", feedLabel: "OPC 社区", section: "社区动态", guide: "OPC 社区、孵化基地、产业园的开园、入驻、运营数据、空间与服务体系变化，以及社区主理人、运营方的公开发布。活动报名归活动，政策文件归政策。" },
  { key: "policy", tagColor: "indigo", label: "政策", feedLabel: "OPC 政策", section: "政策发布", guide: "国家、省、市、区县发布的一人公司（OPC）相关政策、办法、细则、通知、实施方案与官方解读。政策解读文章归政策；对政策的个人评论归观点。" },
  { key: "scenario", tagColor: "orange", label: "场景与订单", feedLabel: "场景与订单", section: "场景与订单", guide: "政府或企业发布的应用场景清单、场景需求、订单机会、供需对接、场景大赛与商业化落地。场景清单里的单个场景按一条资料处理。" },
  { key: "activity", tagColor: "green", label: "活动", feedLabel: "OPC 活动", section: "活动与培训", guide: "OPC 相关的沙龙、培训、路演、创业大赛、供需对接会、政策宣讲等线下或线上活动通知与回顾。活动回顾带真实信息时可归社区动态，但优先归活动。" },
  { key: "industry", tagColor: "violet", label: "产业动态", feedLabel: "产业动态", section: "产业动态", guide: "已发生的企业合作、融资、订单、人才、市场与行业趋势，尤其是与 OPC 社区产业方向（跨境电商、直播电商、AI 内容、钢铁制造等）相关的经营动态。外地经验与全国性数据也归这一类。" },
  { key: "tip", tagColor: "purple", label: "实操指南", feedLabel: "实操指南", section: "实操指南", guide: "读者可以照着做的注册、财税、法务、补贴申报、AI 工具使用、获客与交付方法。重点是步骤与可复用做法；只有态度和预测而无做法归观点。", commentary: true },
  { key: "opinion", tagColor: "blue", label: "观点", feedLabel: "观点", section: "观点与观察", guide: "行业观察、评论、访谈、趋势判断与经验复盘。讨论政策不自动归政策，作者是官员不自动归政策。", commentary: true },
] as const satisfies ReadonlyArray<{ key: string; tagColor: string; label: string; feedLabel?: string; section: string; guide: string; commentary?: true }>;

/**
 * 这个行业最受关注的一类发布（OPC 行业是场景清单）：日报报头的计数按它。
 * category 是类别，tag 是标签，两者都对上才算；unit 接在数字后面。
 */
export const RELEASE: { category: string; tag: string; unit: string } | null = { category: "scenario", tag: "场景开放", unit: "个新场景" };

/** 周报月报总述可以直接写、不必在报道里找到出处的行业通用词（小写）。站名会自动算进去。 */
export const PLAIN_TERMS: readonly string[] = ["opc", "ai", "api", "saas", "aigc", "gmv"];

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 */
export const ITEM_TYPES = ["community_update", "policy_release", "scenario_release", "event_notice", "business_move", "tutorial_explainer", "opinion_analysis"] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/** 每篇资料的第一个标签必须是这些“分类标签”之一。 */
export const CATEGORY_TAGS = [
  "社区动态", "政策发布", "场景开放", "订单机会", "活动通知", "企业动态", "融资/合作", "人才/招聘",
  "教程/实操", "观点/趋势", "外地经验", "其他",
] as const;

/** 可选的主题标签。 */
export const TOPIC_TAGS = [
  "共享办公", "算力/AI工具", "跨境电商", "直播电商", "AI漫剧", "钢铁/制造",
  "政务服务", "财税", "法务", "融资", "人才培训", "场景对接",
] as const;

/** 可选的实体标签（社区、园区、运营机构）。 */
export const ENTITY_TAGS = [
  "青年武界", "丛台数字贸易产业园", "邯郸科创智谷", "峰峰文创社区", "流量城", "馆陶跨境电商园",
] as const;

/** 模型常写的近义词，统一成词表里的写法。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  "社区新闻": "社区动态", "园区动态": "社区动态", "入驻": "社区动态", "开园": "社区动态",
  "政策": "政策发布", "政策解读": "政策发布", "通知": "政策发布", "办法": "政策发布",
  "场景": "场景开放", "需求清单": "场景开放", "订单": "订单机会", "供需对接": "订单机会",
  "活动": "活动通知", "沙龙": "活动通知", "培训": "活动通知", "大赛": "活动通知",
  "公司动态": "企业动态", "合作": "融资/合作", "融资": "融资/合作", "投资": "融资/合作", "并购": "融资/合作",
  "招聘": "人才/招聘", "人才": "人才/招聘",
  "教程": "教程/实操", "指南": "教程/实操", "技巧": "教程/实操", "实践": "教程/实操",
  "观点": "观点/趋势", "趋势": "观点/趋势", "观察": "观点/趋势", "评论": "观点/趋势",
  "外地": "外地经验", "全国": "外地经验",
  "opc": "社区动态", "一人公司": "社区动态",
};

// ── 社区与主体 ──────────────────────────────────────────────────────────────────────────

/**
 * 社区主题：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。
 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[]; orgNames?: string[]; otherNames?: string[] }> = {
  "qingnian-wujie": { name: "青年武界·OPC数字创业社区", displayTag: "青年武界", aliases: ["青年武界", "武安 OPC", "武安市 OPC"], orgNames: ["青年武界"], otherNames: ["武安 OPC 数字创业社区"] },
  "congtai-digital-trade": { name: "丛台区数字贸易产业园 OPC 社区", displayTag: "丛台数字贸易产业园", aliases: ["丛台区数字贸易产业园", "丛台 OPC", "创栖里"], orgNames: ["丛台区数字贸易产业园"], otherNames: ["丛台·创栖里"] },
  "hd-kczg": { name: "邯郸科创智谷 OPC 创享社区", displayTag: "邯郸科创智谷", aliases: ["邯郸科创智谷", "OPC 创享社区"], orgNames: ["邯郸科创智谷"] },
  "hd-kccy": { name: "邯郸科创产业园 OPC 创享空间", displayTag: null, aliases: ["邯郸科创产业园", "OPC 创享空间"], orgNames: ["邯郸科创产业园"] },
  "fengfeng-wenchuang": { name: "峰峰矿区文创 OPC 社区", displayTag: "峰峰文创社区", aliases: ["七厂 OPC 社区", "聚创园", "响堂山 OPC 社区", "磁州窑"], orgNames: ["峰峰矿区"] },
  "chengan-liuliangcheng": { name: "成安流量城电商产业园 OPC 跨境社区", displayTag: "流量城", aliases: ["流量城", "成安 OPC", "成安县 OPC"], orgNames: ["成安县信息谷"] },
  "guantao-kuajing": { name: "馆陶县跨境电商产业园", displayTag: "馆陶跨境电商园", aliases: ["馆陶县跨境电商产业园", "馆陶 OPC"], orgNames: ["馆陶县跨境电商产业园"] },
  "guangping-opc": { name: "广平县 OPC 社区", displayTag: null, aliases: ["广平县 OPC", "鹅城智谷", "智汇广平", "一品一播"], orgNames: ["广平县人工智能OPC专班", "广平融媒"] },
};

/**
 * 身份词典：摘要和标题里出现的机构，必须在原文里也出现过，否则退回原标题、丢掉摘要。
 * 第一版先留空，避免误杀；需要防张冠李戴时再逐个补。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [];

/** 这些域名上的文章，发布方就是对应的机构。第一版留空。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [];

/** 原文里的这些写法也算提到了对应机构。第一版留空。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [];
