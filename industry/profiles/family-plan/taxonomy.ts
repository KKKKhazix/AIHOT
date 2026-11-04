/** 家友计划行业配置评审稿；该目录不由默认应用加载。 */
export const CATEGORIES = [
  { key: "education", tagColor: "indigo", label: "教育学校", section: "教育与学校", guide: "教育政策、课程、考试招生、学校管理和教育实践。区分已经发布或执行的政策，与专家评论和未证实的传闻。" },
  { key: "growth", tagColor: "violet", label: "成长心理", section: "成长与心理", guide: "9–16岁儿童青少年的身心发展、青春期、心理健康、亲子沟通和同伴关系。个案不能泛化为普遍结论。" },
  { key: "health-safety", tagColor: "orange", label: "健康安全", section: "健康与安全", guide: "儿童青少年健康、校园与网络安全、未成年人保护及相关公共事件。医疗建议和风险结论须有可靠依据。" },
  { key: "family-life", tagColor: "green", label: "家庭生活", section: "家庭与社会", guide: "影响家庭决策、家庭关系和日常生活的社会变化与公共服务。普通社会热榜若与目标家庭无明确关联，不因热度入选。" },
  { key: "tech-consumption", tagColor: "turquoise", label: "科技消费", section: "科技与消费", guide: "影响孩子或家庭的数字产品、AI教育应用、平台规则、家庭消费与产品风险。普通科技发布若没有清楚的家庭影响，不自动入选。" },
  { key: "research-trends", tagColor: "blue", label: "研究趋势", section: "研究与趋势", guide: "儿童发展、教育、家庭议题的研究、调查和长期趋势。说明样本、方法、适用范围与局限；研究报道不等于因果证明。" },
  { key: "practical-guides", tagColor: "lime", label: "实用服务", section: "实用指南", guide: "可操作的家长指南、公共服务信息、工具比较和步骤说明。商业推广不得伪装成中立建议。", commentary: true },
  { key: "commentary", tagColor: "purple", label: "观点评论", section: "观点与评论", guide: "作者对教育、成长、家庭或社会议题的解释、判断和主张。明确区分观点与可核实事实。", commentary: true },
] as const;

export const RELEASE = null;
export const PLAIN_TERMS: readonly string[] = ["家庭", "家长", "儿童", "青少年", "教育"];
export const ITEM_TYPES = ["policy_change", "education_event", "research_finding", "health_safety_event", "family_issue", "technology_change", "practical_guide", "opinion_analysis"] as const;
export const CATEGORY_TAGS = ["教育政策", "学校实践", "成长心理", "健康安全", "未成年人保护", "家庭生活", "研究调查", "科技产品", "实用指南", "观点评论", "公共服务", "其他"] as const;
export const TOPIC_TAGS = ["考试招生", "校园", "青春期", "心理健康", "亲子沟通", "同伴关系", "网络安全", "儿童健康", "人工智能", "数字素养", "家庭消费", "学习方法"] as const;
export const ENTITY_TAGS: readonly string[] = [];
