# 行业包

这个站和“行业”有关的一切都在这里。换一个行业，主要就是改这个文件夹，步骤见 [把它改成你的行业](../docs/customize.md)。

| 文件 | 内容 |
|---|---|
| `site.ts` | 站名、行业词、首页文案、关于页、备案号 |
| `taxonomy.ts` | 分类、标签、公司与机构、防止模型写错公司的词表，这个行业最受关注的那类发布（`RELEASE`） |
| `topics.json` | 主题目录（`/topics`），站点启动时读取 |
| `chronicle.ts` | 主题页“大事记”的规则：节点类型、门槛与名额、一篇报道算哪类节点、事件名写法 |
| `chronicles/` | 可选，默认没有：公司编年史的人工历史，一家公司一个 JSON，格式见 [把它改成你的行业](../docs/customize.md#公司编年史的人工历史industrychronicles) |
| `sources.json` | 首次启动时导入的示范信源 |
| `prompts/` | 每一步的提示词：预筛、评分、写作、结构化、归组、事件综述、周报月报、翻译 |
| `selection.ts` | 入选门槛 |
| `features.ts` | 模型榜、Codex 重置监控的开关 |
| `brand/` | 图标、Logo、日报周报月报的报头字 |
| `pages/` | 使用规则、隐私说明（模板，上线前按实际情况改写） |
| `changelog.json` | 更新日志 |
| `gold.example.jsonl` | 精选评测样本的格式示例 |
| `relation-gold.example.jsonl` | 事件关系评测样本的格式示例 |
