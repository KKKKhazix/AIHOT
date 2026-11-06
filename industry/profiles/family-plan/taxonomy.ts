/** 家友计划行业配置评审稿；该目录不由默认应用加载。 */
export const CATEGORIES = [
  { key: "education", tagColor: "indigo", label: "教育学校", section: "教育与学校", guide: "教育政策、课程、考试招生、学校管理和教育实践。既关注孩子的学习，也关注家庭需要理解或参与的学校变化。区分已发布、拟实施与已实施。" },
  { key: "growth", tagColor: "violet", label: "成长心理", section: "成长与关系", guide: "儿童青少年的身心发展、兴趣能力、心理健康、亲子沟通和同伴关系；也包括家长自身的学习与成长。个案和个人经验不能泛化。" },
  { key: "health-safety", tagColor: "orange", label: "健康安全", section: "健康与安全", guide: "家庭成员健康、儿童青少年身心健康、校园与网络安全、未成年人权益及相关公共事件。医疗建议和风险结论须有可靠依据。" },
  { key: "family-life", tagColor: "green", label: "家庭生活", section: "家庭与公共服务", guide: "影响家庭时间、开支、关系、照护与日常安排的社会变化、公共服务、家庭权益和实惠资源。不能只因社会热度而入选。" },
  { key: "tech-consumption", tagColor: "turquoise", label: "科技与消费", section: "科技、AI与消费", guide: "AI与数字工具、家长数字能力、家庭消费、平台规则、科技文化和创作方法。要求能说明对家庭的实际价值，或有具体可验证的学习、创作转化路径；不因出现AI、智能等词自动入选。" },
  { key: "research-trends", tagColor: "blue", label: "研究趋势", section: "研究与趋势", guide: "家庭、教育、儿童发展、消费、科技文化和社会变化的研究、调查与数据。说明样本、方法、适用范围和局限；研究报道不等于因果证明。" },
  { key: "practical-guides", tagColor: "lime", label: "实用资源", section: "方法与资源", guide: "家长可使用的指南、工具比较、公共服务、公开学习资源、家庭项目和创作方法。说明适用对象、步骤、成本、依据及商业关系。", commentary: true },
  { key: "commentary", tagColor: "purple", label: "观点观察", section: "观点与观察", guide: "对家庭、教育、科技文化、消费和社会变化的解释、判断与个人经验。标明观点和事实的边界；单个创作者的做法可以提供灵感，不能代表普遍效果。", commentary: true },
] as const satisfies ReadonlyArray<{ key: string; tagColor: string; label: string; feedLabel?: string; section: string; guide: string; commentary?: true }>;

export const RELEASE: { category: string; tag: string; unit: string } | null = null;
export const PLAIN_TERMS: readonly string[] = ["家庭", "家长", "儿童", "青少年", "教育"];
export const ITEM_TYPES = ["policy_change", "education_event", "research_finding", "health_safety_event", "family_issue", "technology_change", "practical_guide", "opinion_analysis"] as const;
export const CATEGORY_TAGS = ["教育政策", "学校实践", "成长心理", "健康安全", "未成年人保护", "家庭生活", "研究调查", "科技产品", "实用指南", "观点评论", "公共服务", "家庭权益", "家庭资源", "其他"] as const;
export const TOPIC_TAGS = ["考试招生", "校园", "青春期", "心理健康", "亲子沟通", "同伴关系", "网络安全", "儿童健康", "人工智能", "家长AI能力", "数字素养", "家庭消费", "家庭服务", "家庭项目", "创作方法", "兴趣发展", "社会趋势", "学习方法"] as const;
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
