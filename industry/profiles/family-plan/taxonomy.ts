/** 家友计划行业配置评审稿；该目录不由默认应用加载。 */
export const LEGACY_CATEGORIES = [
  { key: "education", tagColor: "indigo", label: "教育学校", section: "教育与学校", guide: "教育政策、课程、考试招生、学校管理和教育实践。既关注孩子的学习，也关注家庭需要理解或参与的学校变化。区分已发布、拟实施与已实施。" },
  { key: "growth", tagColor: "violet", label: "成长心理", section: "成长与关系", guide: "儿童青少年的身心发展、兴趣能力、心理健康、亲子沟通和同伴关系；也包括家长自身的学习与成长。个案和个人经验不能泛化。" },
  { key: "health-safety", tagColor: "orange", label: "健康安全", section: "健康与安全", guide: "家庭成员健康、儿童青少年身心健康、校园与网络安全、未成年人权益及相关公共事件。医疗建议和风险结论须有可靠依据。" },
  { key: "family-life", tagColor: "green", label: "家庭生活", section: "家庭与公共服务", guide: "影响家庭时间、开支、关系、照护与日常安排的社会变化、公共服务、家庭权益和实惠资源。不能只因社会热度而入选。" },
  { key: "tech-consumption", tagColor: "turquoise", label: "科技与消费", section: "科技、AI与消费", guide: "AI与数字工具、家长数字能力、家庭消费、平台规则、科技文化和创作方法。要求能说明对家庭的实际价值，或有具体可验证的学习、创作转化路径；不因出现AI、智能等词自动入选。" },
  { key: "research-trends", tagColor: "blue", label: "研究趋势", section: "研究与趋势", guide: "家庭、教育、儿童发展、消费、科技文化和社会变化的研究、调查与数据。说明样本、方法、适用范围和局限；研究报道不等于因果证明。" },
  { key: "practical-guides", tagColor: "lime", label: "实用资源", section: "方法与资源", guide: "家长可使用的指南、工具比较、公共服务、公开学习资源、家庭项目和创作方法。说明适用对象、步骤、成本、依据及商业关系。", commentary: true },
  { key: "commentary", tagColor: "purple", label: "观点观察", section: "观点与观察", guide: "对家庭、教育、科技文化、消费和社会变化的解释、判断与个人经验。标明观点和事实的边界；单个创作者的做法可以提供灵感，不能代表普遍效果。", commentary: true },
] as const satisfies ReadonlyArray<{ key: string; tagColor: string; label: string; feedLabel?: string; section: string; guide: string; commentary?: true }>;

export const ACTIVE_CATEGORIES = [
  { key: "news", tagColor: "blue", label: "资讯", section: "资讯", guide: "主要报告新的具体事实、变化或进展，且无更明确的其他主要价值。" },
  { key: "policy", tagColor: "indigo", label: "政策", section: "政策", guide: "政策、制度、管理规则和公共服务的内容、变化及实施解释；区分拟议、发布、生效和执行。" },
  { key: "product", tagColor: "turquoise", label: "产品", section: "产品", guide: "主要围绕具体产品或工具的功能、体验、版本或可用性；宣传不等于实测。" },
  { key: "research", tagColor: "violet", label: "研究", section: "研究", guide: "主要提供研究、调查、统计方法或结果，保留样本与限制。" },
  { key: "method", tagColor: "lime", label: "方法", section: "方法", guide: "核心价值是可复现的步骤、工作流或创作办法。", commentary: true },
  { key: "resource", tagColor: "green", label: "资源", section: "资源", guide: "核心价值是可定位、可获得的入口、资料、活动或课程；注明条件与时效。", commentary: true },
  { key: "opinion", tagColor: "purple", label: "观点", section: "观点", guide: "主要提供解释、判断、批评、个人经验或创作者立场；区分观点与事实。", commentary: true },
] as const;
export const CATEGORIES = [...ACTIVE_CATEGORIES, ...LEGACY_CATEGORIES] as const;

export const RELEASE: { category: string; tag: string; unit: string } | null = null;
export const PLAIN_TERMS: readonly string[] = ["家庭", "家长", "儿童", "青少年", "教育"];
export const ITEM_TYPES = ["policy_change", "education_event", "research_finding", "health_safety_event", "family_issue", "technology_change", "practical_guide", "opinion_analysis"] as const;
const LEGACY_CATEGORY_TAGS = ["教育政策", "学校实践", "成长心理", "健康安全", "未成年人保护", "家庭生活", "研究调查", "科技产品", "实用指南", "观点评论", "公共服务", "家庭权益", "家庭资源", "其他"] as const;
export const CATEGORY_TAGS = ["资讯", "政策", "产品", "研究", "方法", "资源", "观点", ...LEGACY_CATEGORY_TAGS] as const;
const LEGACY_TOPIC_TAGS = ["考试招生", "校园", "青春期", "心理健康", "亲子沟通", "同伴关系", "网络安全", "儿童健康", "人工智能", "家长AI能力", "数字素养", "家庭消费", "家庭服务", "家庭项目", "创作方法", "兴趣发展", "社会趋势", "学习方法", "常青内容"] as const;
export const TOPIC_TAGS = [...LEGACY_TOPIC_TAGS, "青少年", "儿童", "家长", "教师", "学生", "老年人", "学前", "小学", "初中", "高中", "中职", "文字创作", "图像创作", "视频创作", "音频创作", "游戏创作", "AI工具", "家庭机器人", "开源项目", "课程课件", "购物决策", "周末活动", "个人信息", "声音肖像", "AI造假", "消费风险", "平台规则", "社会热点", "职业发展", "促销", "省钱", "省事", "省心", "创作启发", "探索线索", "青少年AI使用", "青少年AI认知", "青少年AI素养", "青少年接触AI内容", "青少年AI创作", "青少年AI兴趣", "青少年AI同伴文化", "青春期与AI", "青年谈AI", "学校AI实践", "学校AI规则", "AI辅助学习", "AI与教育评价", "教师AI成长", "AI教育资源", "校外AI培训", "课外AI自学", "AI学习产品测评", "家长学AI", "家长AI应用", "家长AI态度", "家长AI自述", "家庭AI应用", "亲子AI沟通", "AI陪伴", "AI与家庭关系", "AI与心理健康", "家庭AI健康", "长辈数字照护", "AI生活玩法", "家庭科技项目", "亲子数字共创", "AI创作实践", "AI工具实测", "内容工作流", "创作者案例拆解", "内容运营方法", "家庭AI选购", "家庭AI优惠资源", "家庭教育创作AI产品", "家庭教育AI硬件", "AI玩具", "AI技术应用进展", "家庭个人信息保护", "AI数据隐私授权", "AI声音肖像保护", "AI合成信息风险", "未成年人AI内容风险", "家庭AI诈骗冒充", "未成年人网络保护", "平台用户权益", "家庭数字消费风险", "AI公共政策", "AI流行文化", "AI社会文化变化", "AI职业就业变化", "AI升学职业规划", "家庭科技机会", "家庭教育创作行业", "教育者AI表达", "AI多方讨论", "亲子AI兴趣", "AI诈骗冒充", "公众AI素养", "校园AI实践"] as const;
export const ENTITY_TAGS: readonly string[] = [];

export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  教育: "教育政策", 学校: "学校实践", 心理: "成长心理", 亲子: "亲子沟通", 家庭: "家庭生活",
  研究: "研究调查", 调查: "研究调查", 指南: "实用指南", 服务: "公共服务", 科技: "科技产品",
  AI: "人工智能", ai: "人工智能", 家长AI: "家长AI能力", AI素养: "数字素养", 创作: "创作方法",
  兴趣: "兴趣发展", 实惠资源: "家庭资源",
};

export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[]; orgNames?: string[]; otherNames?: string[] }> = {};
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [];
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [];
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [];
