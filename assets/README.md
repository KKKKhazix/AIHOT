# 资产

站点直接从这里提供这些文件。随文件的 NOTICE 和 LICENSE 一起保留。

| 目录 | 内容 | 注意 |
|---|---|---|
| `og-fonts/` | Noto Sans SC 400/700（SIL OFL 1.1，见目录里的 LICENSE） | 只用于服务端生成分享图；网页用系统字体，不发字体请求 |
| `model-providers/` | 模型厂商与模型系标志，模型榜所有型号的标志都放这里 | 商标归各自所有者，只用于标识，见 NOTICE；映射在 `packages/backend/src/leaderboard/registry.ts`，先按模型系匹配，再回退厂商标志（厂商由 `providers.ts` 推断）；没有标志的型号显示首字母 |
| `leaderboard-sources/` | 评测来源的官方标志，模型榜用 | 商标归各自所有者，只用于标识，见 NOTICE |

站点自己的图标、Logo、报头字在 `industry/brand/`，换行业时换那里的文件。
