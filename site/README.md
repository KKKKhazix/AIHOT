# 站点

这个站自己的东西：名字、文案、品牌、页面，以及启用哪些模块。步骤见 [把它改成你的行业](../docs/customize.md)。

| 文件 | 内容 |
|---|---|
| `site.ts` | 站名、行业词、出刊时间、首页和关于页文案、分享图文字、条目与日报周报月报上的说法、公开接口的分类、备案号 |
| `models.ts` | 具名的模型和每一步默认用哪个（没写的步骤用 `.env` 里配的那一个） |
| `brand/` | 图标、Logo（`Logo.tsx`）、分享图和海报上的字标（`wordmark.svg`、`wordmark-dark.svg`，可选）、日报周报月报的报头字（`nameplates/`）、关于页的二维码（`contact/`，可选） |
| `pages/` | 使用规则、隐私说明（模板，上线前按实际情况改写） |
| `public/` | 发布在网站根目录的固定文件（站名、地址等占位符替换后发布）：`robots.txt`、`manifest.webmanifest`、`openapi-v1.json`，以及可选的 `.well-known/security.txt` |
| `changelog.json` | 更新日志 |
| `modules/` | 启用哪些模块：`index.ts`、`server.ts`、`web.ts` 三份清单，列出仓库根目录 `modules/<名字>/` 里要用的模块，默认都为空，见 [架构](../docs/architecture.md#模块) 的“模块” |
