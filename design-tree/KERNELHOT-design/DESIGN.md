# KernelHOT — Linux 内核热点站 · 需求与领域设计

> **票型**：设计票
> **创建日期**：2026-10-22
> **状态**：用户确认，待实施
> **上游工单**：task_cd6d26f1e3e6

---

## 1. 站名与运营者信息

| 字段 | 值 | 去向 |
|---|---|---|
| `SITE.name` | `KernelHOT` | 写入 `site/site.ts` |
| `SITE.organization.name` | `KernelHOT` | 写入 `site/site.ts` |
| `SITE.subject` | `Linux 内核` | 写入 `site/site.ts` |
| `SITE.homeTitle` | `KernelHOT — Linux 内核动态 · 每日精选与日报` | 写入 `site/site.ts` |
| `SITE.topicsTitle` | `Linux 内核主题：公司与版本、技术方向、内容形态的最新动态` | 写入 `site/site.ts` |
| `SITE.tagline` | `值得看的 Linux 内核动态` | 写入 `site/site.ts` |
| `SITE.keywords` | `["Linux 内核", "内核动态", "内核日报", "内核精选"]` | 写入 `site/site.ts` |
| `SITE.locale` | `zh-CN` | 写入 `site/site.ts` |
| `SITE.mcpPrefix` | `kernelhot` | 写入 `site/site.ts` |
| `SITE.footerNote` | 可设为 `null`（去掉"由 AIHOT 开源框架驱动"署名）或改为框架署名但不提 AIHOT | 待用户上线前确认 |
| `SITE.icp` / `SITE.psb` | `null`（暂不填写） | 写入 `site/site.ts`，有真实号码后再填 |
| `SITE.github` | （待用户提供仓库地址） | 写入 `site/site.ts` |
| `SITE.crawlerName` | `KernelHOTBot/1.0` | 写入 `site/site.ts` |
| `SITE.contactEmail` | （待用户提供） | 写入 `site/site.ts` |

**运营者决策点**：`footerNote`、`github`、`contactEmail` 需在上线前由用户填写。

---

## 2. 目标读者 / 地域 / 语言

| 维度 | 决策 |
|---|---|
| 目标读者 | 内核开发者、子系统维护者、发行版内核工程师，关注内核安全与性能的工程师 |
| 地域与语言 | 全球英文与中文信源采集，输出为简体中文 |
| 范围边界 | **聚焦 Linux 内核本身**，不收泛 Linux 用户空间软件、发行版使用教程和普通开源资讯 |

**实施路径**：上述信息写入 `site/site.ts` 的 `description`、`ABOUT.headline`、`ABOUT.lead` 和 `ABOUT.steps` 文案中。

---

## 3. 出刊节奏与通知渠道

| 报告 | 北京时间出刊时间 | 说明 |
|---|---|---|
| 日报 | 每天 08:00 | 收前 24 小时内容 |
| 周报 | 每周一 10:00 | 从日报汇编 |
| 月报 | 每月 1 日 10:30 | 从日报汇编 |

**编辑项**：

- `EDITION_TIMES = { daily: "08:00", weekly: "10:00", monthly: "10:30" }`
- `EDITION_WHEN` 自动派生为 `每天 08:00`、`每周一 10:00`、`每月 1 日 10:30`

**通知渠道**：首版不提供飞书、邮件等推送。只提供网站、RSS、公开 API、Agent Markdown、MCP。后续有明确需求和凭证再启用。

---

## 4. 信源体系

### 4.1 分级策略

| 分级 | 定义 | 入选门槛 | 来源 |
|---|---|---|---|
| T1 | 官方一手 | 60 | kernel.org version/CVE RSS/JSON、linux-kernel-announce、LKML (Lore)、重点 Lore 子系统列表（linux-kernel, netdev, bpf, linux-mm, linux-fsdevel, linux-block, linux-pm, linux-riscv, linux-arm-kernel, dri-devel, kvm）、git.kernel.org 主线/stable/linux-next 版本/Tag/合并窗口信号 |
| T1.5 | 官方账号与准官方 | 65 | KernelNewbies（解读）、LPC、Kernel Summit；维护者博客待白名单 |
| T2 | 媒体与个人 | 76 | LWN、Phoronix（摘要+原文链接，不抓付费正文） |

**约束**：
- 所有来源默认 `site_fulltext: false`，`syndicate_fulltext: false`。
- 不直接抓取整个 LKML，重点抓发布、安全、合并窗口结果与约 8–10 个重点子系统列表。
- 不直接收录所有 Git commit，仅把主线/stable/linux-next 的版本/Tag、合并窗口汇总和重大变更作为信号。
- LWN 只展示摘要和原文链接，不要求付费账号。

### 4.2 信源起草计划

实施阶段按以下标准格式起草信源配置，逐个试抓验证：

```json
{
  "id": "rss-kernel-org-versions",
  "name": "kernel.org version announcements",
  "kind": "rss",
  "config": { "feedUrl": "https://www.kernel.org/feeds/kernel-os-latest.xml" },
  "tier": "T1",
  "participation_mode": "editorial",
  "interval_minutes": 240,
  "site_fulltext": false,
  "syndicate_fulltext": false
}
```

**待实施确认项**：
- 每个具体 feed URL 在试抓后确认可用性
- Lore 子系统列表的 feed URL（通常格式为 `https://lore.kernel.org/linux-kernel/all/rss`）
- 维护者博客白名单待定

---

## 5. 重要消息与噪声定义

### 5.1 重要性排序（由高到低）

1. **已利用或影响广泛的安全问题**（有可利用性的 CVE、远程利用漏洞、特权提升）
2. **重大回归**（影响广泛的性能回归、稳定性回归、已合并到主线的回归）
3. **正式版 / RC / LTS 内核发布与合并窗口结果**
4. **重要子系统变更或重大硬件支持**（新架构支持、重大驱动重构）
5. **可复现的显著性能变化**（有基准数据和对比方法）
6. **社区治理与架构决策**（维护者变动、RCF 变更、架构决议）
7. **深度技术解读**（有方法说明、可复现的分析文章）

### 5.2 CVE 判定规则

CVE 不因有编号就自动成为热点。需结合以下因素判断：
- **影响范围**：影响的内核版本数量、是否影响 LTS 版本
- **可利用性**：是否为本地提权 / 远程利用 / 需要物理接触
- **修复状态**：补丁是否已提交 / 已合并 / 仅存在于发行版
- **上下文**：是否已造成实际利用事件

### 5.3 噪声压制

以下内容在评分中需压制（低 `sig`、低 `reson`）：

| 噪声类型 | 压制策略 |
|---|---|
| 无结论的邮件列表争论 | `sig ≤ 2` |
| 补丁 v2/v3 等日常迭代 | `sig ≤ 3`，除非有明显功能变化 |
| 重复的 CI / 回归测试报告 | `sig ≤ 3` |
| 普通 stable 回移 | `sig ≤ 3` |
| 无明显用户影响的发行版小修 | `sig ≤ 4` |
| 无方法说明的跑分 | `sig ≤ 3`, `nov ≤ 2` |
| 营销稿、厂商软文 | `sig ≤ 2` |
| 泛 Linux 教程、桌面教程 | BLOCK（预筛阶段拦截） |
| 社区八卦、人事流言 | BLOCK（预筛阶段拦截） |
| 重复转载（同一事件无新信息） | 聚类阶段过滤 |

---

## 6. 分类 / 标签 / 主题

### 6.1 分类体系（`industry/taxonomy.ts`）

| key | label | section | guide 要点 | commentary |
|---|---|---|---|---|
| `security` | 安全与修复 | 安全与重大回归 | CVE、安全补丁、安全缓解措施、已知漏洞利用 | |
| `release` | 版本与主线 | 版本发布与主线合并 | 主线内核发布、RC、LTS、合并窗口结果 | |
| `subsystem` | 子系统进展 | 子系统、硬件与驱动 | 具体子系统（网络、文件系统、内存、调度等）的重大改动 | |
| `driver` | 硬件与驱动 | 子系统、硬件与驱动 | 新驱动、硬件支持、驱动重构、GPU/网络驱动 | |
| `performance` | 性能与可靠性 | 性能与可靠性 | 性能优化、性能回归、基准测试、可靠性改进 | |
| `distro` | 发行版内核 | 发行版、社区与深度解读 | Red Hat、SUSE、Canonical 等发行版内核工程改动 | |
| `community` | 社区与治理 | 发行版、社区与深度解读 | RCF 变更、维护者变动、Kernel Summit/LPC | |
| `article` | 技术解读 | 发行版、社区与深度解读 | 技术文章、深度解读、架构分析（需有方法说明） | true |

### 6.2 报告分节顺序

1. **安全与重大回归**（最优先）
2. **版本发布与主线合并**
3. **子系统、硬件与驱动**
4. **性能与可靠性**
5. **发行版、社区与深度解读**

### 6.3 内容类型（`ITEM_TYPES`）

| 类型 key | 说明 | 对应分类标签 |
|---|---|---|
| `kernel_release` | 版本发布、RC、LTS、合并窗口 | 版本与主线 |
| `security_fix` | 安全修复、CVE | 安全与修复 |
| `subsystem_change` | 子系统改动、架构变更 | 子系统进展 |
| `driver_update` | 驱动更新、新硬件支持 | 硬件与驱动 |
| `performance` | 性能优化/回归 | 性能与可靠性 |
| `distro_kernel` | 发行版内核改动 | 发行版内核 |
| `community_governance` | 社区治理、维护者变动 | 社区与治理 |
| `technical_article` | 技术解读、架构分析 | 技术解读 |

### 6.4 公司/主体名录（`ENTITIES` / `topics.json`）

| id | name | 说明 |
|---|---|---|
| `red-hat` | Red Hat | RHEL 内核、KVM、系统管理 |
| `suse` | SUSE | SLES 内核、SUSE 贡献 |
| `canonical` | Canonical | Ubuntu 内核、Livepatch |
| `google` | Google | Android 内核、GCP 内核贡献 |
| `intel` | Intel | 驱动、电源管理、scheduler |
| `amd` | AMD | GPU 驱动、ROCm、scheduler |
| `nvidia` | NVIDIA | 专有驱动、GPU 计算 |
| `arm` | Arm | ARM 架构支持、Neoverse |
| `ibm` | IBM | PowerPC、z/Architecture、存算一体 |
| `oracle` | Oracle | Oracle Linux、SPARC 内核 |
| `microsoft` | Microsoft | WSL2、Windows on ARM 内核 |
| `amazon-aws` | Amazon / AWS | AWS 内核优化、Graviton |
| `meta` | Meta | L4 Kernel、基础设施 |
| `huawei` | 华为 | 华为内核贡献（鸿蒙/欧拉等） |
| `alibaba` | 阿里巴巴 | 阿里云内核贡献 |
| `tencent` | 腾讯 | 腾讯内核贡献 |
| `linux-foundation` | Linux Foundation | 内核治理、LPC、Kernel Summit |

### 6.5 主题目录（`topics.json`）

- **company 组**：上述公司/主体，slug 为 id
- **field 组**：按子系统划分（网络、文件系统、内存管理、调度、电源管理等）
- **genre 组**：按内容形态划分（版本发布、安全修复、技术解读等）

---

## 7. 评分标准设计

### 7.1 保留框架结构

评分系统保留框架原有的五维加权结构：

| 维度 | 说明 |
|---|---|
| `sig` 实质份量 | 对内核开发者注意力价值 |
| `nov` 信息增量 | 带来了多少明确的新认知 |
| `cred` 证据强度 | 材料内部对核心事实的支持度 |
| `reson` 共振面 | 多少读者会觉得与自己有关 |
| `act` 可用性 | 读者是否可使用、学习或调整选择 |

### 7.2 八类型权重表（设计稿）

| 类型 | sig | nov | cred | reson | act | 合计 |
|---|---:|---:|---:|---:|---:|---:|
| `kernel_release` | 3 | 2 | 2 | 2 | 1 | 10 |
| `security_fix` | 3 | 2 | 3 | 2 | 0 | 10 |
| `subsystem_change` | 2 | 2 | 2 | 2 | 2 | 10 |
| `driver_update` | 2 | 2 | 1 | 2 | 3 | 10 |
| `performance` | 2 | 2 | 2 | 2 | 2 | 10 |
| `distro_kernel` | 2 | 1 | 2 | 3 | 2 | 10 |
| `community_governance` | 2 | 2 | 2 | 3 | 1 | 10 |
| `technical_article` | 1 | 1 | 1 | 3 | 4 | 10 |

**实施路径**：权重表写入 `industry/prompts/selection-score.md`，与现有 AI 行业的结构保持一致，只替换类型和例子。

### 7.3 门槛（`industry/selection.ts`）

门槛沿用框架默认值，待样本校准后调整：

| 分级 | 门槛 |
|---|---|
| T1 | 60 |
| T1.5 | 65 |
| T2 | 76 |

**校准路径**：用 100–200 条标注样本运行 `scripts/eval-selection.ts`，在 SelectBench 中逐条检查判错项，迭代调整提示词和门槛。

---

## 8. 品牌方向

| 项目 | 方向 |
|---|---|
| Logo | 原创文字标 "KernelHOT"，配极简"内核环/终端光标"图形 |
| 不使用 | AIHOT Logo、Tux 图案 |
| 配色 | 深灰蓝 + 内核橙 |
| 报头字 | 重新生成（`daily` → "内核日报" 等） |

**实施路径**：`site/brand/` 下的 `logo.svg`、`icon.png`、`wordmark.svg` 替换；`nameplates` 重新生成。

---

## 9. 条款与隐私

### 9.1 使用规则（`site/pages/terms.md`）

| 条款内容 | 状态 |
|---|---|
| 只提供原创摘要和原文链接 | 待确认稿 |
| 原文版权归来源方所有 | 待确认稿 |
| 引用本站内容需注明出处 | 待确认稿 |
| 禁止绕过限流批量抓取 | 待确认稿 |
| 商业化批量使用需事先授权 | 待确认稿 |

### 9.2 隐私说明（`site/pages/privacy.md`）

| 隐私项 | 状态 |
|---|---|
| 收藏和阅读设置仅存在浏览器本地 | 待确认稿 |
| 服务器保留必要访问与安全日志 | 待确认稿 |
| 不建立公开用户档案 | 待确认稿 |
| 不投放广告追踪 Cookie | 待确认稿 |
| 第三方基础设施可能按其政策处理 IP | 待确认稿 |

### 9.3 备案

- ICP：留空（`null`）
- 公安备案：留空（`null`）

**重要**：条款和隐私均为**待上线确认稿**，正式上线前必须由用户最终审阅。

---

## 10. 评分中的内容类型对应关系

### 10.1 五维加权类型权重

评分提示词中的类型权重表（`selection-score.md`）需从 AI 行业的 7 种类型替换为内核领域的 8 种类型：

| 内核类型 | 说明 | 对应原 AI 类型 |
|---|---|---|
| `kernel_release` | 版本发布、RC、LTS | ≈ `model_release` |
| `security_fix` | 安全修复、CVE | ≈ 独立类型 |
| `subsystem_change` | 子系统改动 | ≈ `product_launch` + `research_paper` |
| `driver_update` | 驱动更新 | ≈ `product_launch` |
| `performance` | 性能变化 | ≈ `opinion_analysis`（如果是分析）或 `research_paper`（如果是基准） |
| `distro_kernel` | 发行版内核改动 | ≈ `industry_event` |
| `community_governance` | 社区治理 | ≈ `opinion_analysis` |
| `technical_article` | 技术解读 | ≈ `tutorial_explainer` |

### 10.2 噪声规则重写

`selection-score.md` 的"必须正常评价的价值"和"必须压住的噪声"部分需替换为内核领域例子：

**必须正常评价**：
- 已确认利用的内核安全漏洞（远程/提权）
- 正式合并的重要新功能（大规模子系统改动、新架构支持）
- 有明确数据和可复现方法的性能回归/优化
- 重大治理决议（维护者变动、RCF 更新、架构决策）

**必须压制**：
- 补丁迭代日常通知（v2 → v3）
- 无结论的邮件争论
- 重复 CI 报告
- 发行版 minor 更新中的普通 bug 修复
- 无方法说明的跑分

---

## 11. 提示词修改范围

以下提示词文件需要内容重写（保留结构、替换行业例子）：

| 文件 | 修改内容 |
|---|---|
| `industry/prompts/prefilter.md` | 预筛：从"AI 相关性"改为"Linux 内核相关性" |
| `industry/prompts/selection-score.md` | 评分标准：八类型权重表 + 内核噪声规则 |
| `industry/prompts/structure.md` | 结构化：八分类标签 + 内核公司主体 |
| `industry/prompts/content-understanding.md` | 标题摘要写法：内核领域术语规则 |
| `industry/prompts/rules-domain.md` | 术语翻译规则：内核术语保留/翻译 |
| `industry/prompts/story-digest.md` | 事件综述：内核事件写法 |
| `industry/prompts/report-period.md` | 周报月报总述：内核领域说法 |
| `industry/prompts/report-period-sections.md` | 栏目导读：内核分类名 |
| `industry/prompts/summarize-article.md` | 文章摘要：内核文章写法 |

**保持不变的提示词**：`group-*.md`（事件归组逻辑）、`safety.md`（安全边界）、`rules-anti-hallucination.md`（防幻觉规则）、`mend-wording.md`（改用词，只需更新词表）。

---

## 12. 后续实施与校准路径

### 12.1 实施阶段

按 `docs/customize.md` 的顺序执行：

1. **站名与文案** → `site/site.ts`（已完成决策）
2. **分类、标签、主题** → `industry/taxonomy.ts`、`industry/topics.json`（已完成决策）
3. **信源** → `industry/sources.json`（需起草 URL + 试抓验证）
4. **精选标准** → `industry/prompts/` 系列（需重写行业例子）
5. **门槛与校准** → `industry/selection.ts` + SelectBench（需标注样本）
6. **品牌** → `site/brand/`（需重新生成报头字）
7. **页面文案** → `site/pages/terms.md`、`site/pages/privacy.md`、`site/public/`

### 12.2 校准路径

1. 从信源采集 100–200 条资料
2. 人工标注"该选/不该选"，存为 `.data/gold.jsonl`
3. 运行 `scripts/eval-selection.ts` 看指标
4. 在后台 SelectBench 逐条检查判错项
5. 迭代调整提示词和门槛

### 12.3 报告

- `industry/README.md` 更新为 Linux 内核领域简介
- `site/changelog.json` 首条写上线记录

---

## 13. 设计约束与边界

| 约束 | 说明 |
|---|---|
| 不使用 AIHOT 名字和 Logo | 品牌全部原创 |
| 全文展示默认关闭 | `site_fulltext` / `syndicate_fulltext` 默认 false |
| 模型调用不在读者页面触发 | 模型只在 worker 任务中调用 |
| 付费请求经过回执和预算熔断 | 不绕开 |
| 安全阀开发时保持关闭 | `COLLECT_ENABLED`、`MODEL_CALLS_ENABLED` 等 |
| 匿名管理员/访客看到一样 | 公开内容匿名 |

---

## 14. Answer — Grilling 轮次与去向

### Grilling 轮次 1：站名与运营定位

| 问题 | 去向 | 结果 |
|---|---|---|
| Q1: 站名？ | 人定 | KernelHOT → 写入 site/site.ts |
| Q2: 行业词？ | 人定 | Linux 内核 → 写入 site/site.ts |
| Q3: 界面语言？ | 人定 | zh-CN → 写入 site/site.ts |
| Q4: 目标读者？ | 人定 | 内核开发者/维护者/工程师 → 写入 ABOUT |
| Q5: 地域/语言？ | 人定 | 全球信源中文输出 → 写入 description |
| Q6: 出刊时间？ | 人定 | 日08:00/周一10:00/月1日10:30 → 写入 EDITION_TIMES |
| Q7: 首页/关于页文案？ | 人定 | 按上述定位起草，待交付前确认 |

### Grilling 轮次 2：分类、重要性、噪声

| 问题 | 去向 | 结果 |
|---|---|---|
| Q8: 分类体系？ | 人定 | 8 类（版本与主线、安全与修复、子系统进展、硬件与驱动、性能与可靠性、发行版内核、社区与治理、技术解读）→ 写入 taxonomy.ts |
| Q9: 报告分节？ | 人定 | 5 节（安全回归→版本发布→子系统硬件→性能→发行版社区）→ 写入 section 配置 |
| Q10: 重要性排序？ | 人定 | 安全>回归>发布>子系统>性能→ 写入评分规则 |
| Q11: 噪声定义？ | 人定 | 邮件争论/vN迭代/重复CI/普通小修/跑分/营销稿→ 写入 selection-score.md 噪声规则 |

### Grilling 轮次 3：主体、品牌、条款

| 问题 | 去向 | 结果 |
|---|---|---|
| Q12: 重点公司/主体？ | 人定 | 17 家公司/组织 → 写入 ENTITIES + topics.json |
| Q13: Logo 方向？ | 人定 | 原创文字标+极简内核环图形，配色深灰蓝+内核橙 |
| Q14: tagline/首页标题？ | 人定 | 采用推荐方案 → 写入 site/site.ts |
| Q15: 使用规则？ | 人定 | 摘要聚合+注明来源+禁止爬取+商业授权 → 写入 terms.md |
| Q16: 隐私说明？ | 人定 | 本地存储+访问日志+无广告Cookie → 写入 privacy.md |
| Q17: ICP/公安备案？ | 人定 | 暂留空 → site/site.ts 设 null |

### Grilling 轮次 4：信源与评分

| 问题 | 去向 | 结果 |
|---|---|---|
| Q19: 具体 feed URL？ | 代答 | worker 按标准格式起草，实施阶段试抓验证 |
| Q20: 维护者博客策略？ | 人定 | KernelNewbies T1.5，LPC/Summit 会议源，维护者博客白名单制 |
| Q21: LWN/Phoronix 处理？ | 人定 | T2 精选源，摘要+原文链接，不抓付费正文 |
| Q22: 内容类型八类划分？ | 人定 | 采用推荐八类 → 写入 selection-score.md |
| Q23: 通知渠道？ | 人定 | 首版不接飞书/邮件，仅提供网站+RSS+API+MCP |

---

## 15. 后续实施入口

| 入口 | 文件范围 | 依赖 |
|---|---|---|
| 站名/文案修改 | `site/site.ts` | 无 |
| 分类/标签/主题重构 | `industry/taxonomy.ts`、`industry/topics.json` | 无 |
| 信源起草与试抓 | `industry/sources.json` | 需逐个验证 URL 可用性 |
| 提示词重写 | `industry/prompts/` 系列 | 需 8 类分类定义 |
| 公司主体录入 | `industry/taxonomy.ts` ENTITIES | 无 |
| 术语翻译规则 | `industry/prompts/rules-domain.md` | 需内核术语表 |
| 品牌素材替换 | `site/brand/` | 需设计稿 |
| 条款/隐私重写 | `site/pages/terms.md`、`site/pages/privacy.md` | 用户上线前确认 |
| 门槛校准 | `industry/selection.ts` + SelectBench | 需标注样本 |
| 报头字重新生成 | `site/brand/nameplates/` | `scripts/nameplates.ts` |
