// 英文版用的行业词：类别、标签、主题和公司的英文名。键是 taxonomy.ts、topics.json 里的中文写法或 key；
// 换行业时和它们一起改。网页英文页和英文的公开接口都读这里，没写到的词照原样显示；tests/industry-english.standalone.test.ts 检查都写到了。
import type { CATEGORIES } from "./taxonomy.ts";

type CategoryKey = (typeof CATEGORIES)[number]["key"];

/** 类别：筛选标签、分类 RSS 标题、日报栏目。 */
export const CATEGORY_EN: Record<CategoryKey, { label: string; feedLabel: string; section: string }> = {
  "ai-models": { label: "Models", feedLabel: "AI Models", section: "Model releases & updates" },
  "ai-products": { label: "Products", feedLabel: "AI Products", section: "Product launches & updates" },
  industry: { label: "Industry", feedLabel: "Industry News", section: "Industry news" },
  paper: { label: "Papers", feedLabel: "Papers", section: "Research papers" },
  tip: { label: "Tutorials", feedLabel: "Tutorials", section: "Tips & opinions" },
  opinion: { label: "Opinion", feedLabel: "Opinion", section: "Tips & opinions" },
};

/** 标签（含 TAG_DISPLAY 里给读者看的短词）。 */
export const TAG_EN: Record<string, string> = {
  产品更新: "Product updates", 模型发布: "Model releases", "论文/研究": "Research", 论文: "Papers", "开源/仓库": "Open source", 开源: "Open source",
  "教程/实践": "Tutorials", 教程: "Tutorials", "现象/趋势": "Trends", 趋势: "Trends", 大佬观点: "Opinion", "评测/基准": "Benchmarks", 评测: "Benchmarks",
  "安全/对齐": "Safety", 安全: "Safety", 行业动态: "Industry", "政策/监管": "Policy", 政策: "Policy", "非AI/通用工具": "General tools", 其他: "Other",
  Agent: "Agents", 编码: "Coding", 推理: "Reasoning", 多模态: "Multimodal", 语音: "Voice", 视频: "Video", 图像生成: "Image generation", RAG: "RAG",
  端侧: "On-device", "数据/训练": "Data & training", 数据与训练: "Data & training", 搜索: "Search", "部署/工程": "Engineering", 工程部署: "Engineering",
  开源生态: "Open source", 具身智能: "Embodied AI", "MCP/工具调用": "MCP & tool use", "MCP 与工具调用": "MCP & tool use",
};

/** 主题（topics.json 的 slug）：名字和一句话介绍。 */
export const TOPIC_EN: Record<string, { name: string; definition: string }> = {
  openai: { name: "OpenAI / ChatGPT", definition: "The latest on GPT models, ChatGPT and Sora, plus OpenAI's strategy and people." },
  anthropic: { name: "Anthropic / Claude", definition: "Claude models, Claude Code and Anthropic's products, research and company news." },
  google: { name: "Google / Gemini", definition: "Gemini models and apps, Google DeepMind research and Google's AI products." },
  deepseek: { name: "DeepSeek", definition: "DeepSeek's model releases, papers, open weights and API changes." },
  qwen: { name: "Qwen", definition: "Alibaba's Qwen models, the Qwen app and Alibaba Cloud's AI news." },
  kimi: { name: "Moonshot AI / Kimi", definition: "Kimi models and apps from Moonshot AI, and the company's news." },
  minimax: { name: "MiniMax", definition: "MiniMax's models for text, speech, video and images, and its products." },
  zhipu: { name: "Zhipu GLM", definition: "Zhipu AI's GLM models, Z.ai products and company news." },
  xai: { name: "xAI / Grok", definition: "Grok models and apps from xAI, and the company's news." },
  meta: { name: "Meta / Llama", definition: "Meta's AI models, Llama, Meta AI products and its superintelligence lab." },
  microsoft: { name: "Microsoft / Copilot", definition: "Copilot, Microsoft's own models and its AI platform and research." },
  nvidia: { name: "NVIDIA", definition: "NVIDIA's AI chips, systems, software and models, and company news." },
  "hugging-face": { name: "Hugging Face", definition: "Hugging Face's platform, open-source libraries, models and datasets." },
  cursor: { name: "Cursor", definition: "The Cursor AI code editor: releases, models and company news." },
  openrouter: { name: "OpenRouter", definition: "OpenRouter's model marketplace, rankings and API changes." },
  agent: { name: "Agents", definition: "AI agents that plan and act: products, frameworks, research and real-world use." },
  coding: { name: "AI Coding", definition: "AI for writing software: coding models, coding agents, IDEs and how developers use them." },
  reasoning: { name: "Reasoning", definition: "How models reason: reasoning models, test-time compute and the research behind them." },
  multimodal: { name: "Multimodal", definition: "Models that see, hear and read together, and what they're used for." },
  "image-gen": { name: "Image Generation", definition: "Image generation and editing models and products." },
  video: { name: "AI Video", definition: "Video generation models, tools and how they're used." },
  voice: { name: "Voice & Audio", definition: "Speech recognition, voice synthesis, voice agents and music generation." },
  embodied: { name: "Embodied AI", definition: "Robots and AI in the physical world: models, hardware and research." },
  "on-device": { name: "On-device AI", definition: "Small models and AI running on phones, laptops and other devices." },
  "open-source": { name: "Open Source", definition: "Open-weight models, open-source AI projects and the community around them." },
  engineering: { name: "Engineering", definition: "Serving, deploying and building with AI models in production." },
  "data-training": { name: "Data & Training", definition: "Training data, training methods and the infrastructure behind new models." },
  safety: { name: "Safety & Alignment", definition: "AI safety, alignment, security and misuse: research and incidents." },
  mcp: { name: "MCP & Tool Use", definition: "The Model Context Protocol and how models call tools." },
  "model-releases": { name: "Model Releases", definition: "New models and model updates from every lab." },
  "product-updates": { name: "Product Updates", definition: "New AI products and features, and changes to existing ones." },
  papers: { name: "Research Papers", definition: "Papers, technical reports, benchmarks and datasets." },
  benchmarks: { name: "Benchmarks", definition: "New benchmarks, leaderboards and how models score on them." },
  tutorials: { name: "Tutorials", definition: "How-tos, prompts, workflows and hands-on lessons you can reuse." },
  opinions: { name: "Opinion", definition: "What leading people in AI think: essays, interviews and predictions." },
  trends: { name: "Trends", definition: "Patterns across the AI world: adoption, markets and how things are changing." },
  industry: { name: "Industry News", definition: "Funding, deals, people, partnerships, lawsuits and other company news." },
  policy: { name: "Policy & Regulation", definition: "AI laws, regulation, government policy and their effects." },
};

/** 主题分组（topics.json 的 groups）。 */
export const TOPIC_GROUP_EN: Record<string, { name: string; blurb: string }> = {
  company: { name: "Companies & Models", blurb: "Follow the key companies: model releases, product changes and moves" },
  field: { name: "Research Areas", blurb: "Go deep by area: agents, multimodal, embodied AI…" },
  genre: { name: "Content Types", blurb: "Browse by kind: new models, papers, tutorials, opinion…" },
};

/** 日报报头“N 个新模型”。 */
export const RELEASE_UNIT_EN = { one: "new model", many: "new models" };
