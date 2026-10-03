# 站点

这个站自己的东西：名字、文案、品牌、页面，以及启用哪些模块。步骤见 [把它改成你的行业](../docs/customize.md)。

| 文件 | 内容 |
|---|---|
| `site.ts` | 站名、行业词、首页文案、关于页、分享图文字、备案号 |
| `models.ts` | 具名的模型和每一步默认用哪个（没写的步骤用 `.env` 里配的那一个） |
| `brand/` | 图标、Logo（`Logo.tsx`）、日报周报月报的报头字 |
| `pages/` | 使用规则、隐私说明（模板，上线前按实际情况改写） |
| `public/` | 原样发布在网站根目录的文件：`robots.txt`、`manifest.webmanifest`、`openapi-v1.json` |
| `changelog.json` | 更新日志 |
| `modules/` | 启用的模块（`modules/<名字>/`），默认为空，见 [架构](../docs/architecture.md) 的“模块” |
