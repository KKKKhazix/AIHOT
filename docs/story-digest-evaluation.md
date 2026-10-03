# 事件综述提示词评测

事件综述由 `industry/prompts/story-digest.md` 生成。它属于读者直接看到的模型输出，修改提示词时需要固定输入做前后对照，而不是只凭线上页面印象判断。

本仓库提供一个轻量评测脚本：

```bash
node --env-file=.env scripts/eval-story-digests.ts \
  --cases .data/story-digest-cases.jsonl
```

它直接复用生产环境的：

- `story-digest` prompt 与 prompt version；
- digest model capability；
- JSON schema；
- 报道输入格式；
- receipt / budget 机制。

它**不会**修改 story、写入生产综述或自动判断哪种文风“更好”。

## 准备案例

把案例放在不会提交的 `.data/` 目录。仓库中的 `industry/story-digest-eval.example.jsonl` 是纯虚构格式示例。

每行一个事件：

```json
{"caseId":"example","reports":[{"id":"r1","publishedAt":"2026-09-01T09:00:00+08:00","source":"Acme","firstParty":true,"title":"...","summary":"..."}]}
```

案例最多包含 40 篇报道，与生产综述当前的输入窗口一致。

## 比较模型

默认使用当前 `digest` capability 配置的模型。也可以显式比较多个已配置模型：

```bash
node --env-file=.env scripts/eval-story-digests.ts \
  --cases .data/story-digest-cases.jsonl \
  --models default,deepseek-flash
```

报告写到 `.data/eval/story-digests-*.json`，记录：

- prompt version；
- model；
- 每个 case 的 `title` / `digest` / `latest`；
- receipt id 与是否复用；
- token / provider latency 汇总；
- generation error（如有）。

## 比较 prompt revision

脚本始终运行当前 checkout 的生产 prompt。要比较 prompt 修改前后：

1. 在修改前运行一次并保留报告；
2. 修改 `story-digest.md`；
3. 对同一份 cases 再运行一次；
4. 按 `caseId` 人工比较两个报告。

prompt version 会随提示词内容哈希变化，因此报告能够明确指出每次输出对应哪一版 wording。

## 评测边界

事件综述没有可靠的单一自动指标。不要为了方便而加入没有人工依据的 LLM judge 分数或“质量分”。

适合人工比较的维度包括：

- 是否先给出核心变化与当前结论；
- 是否重复下方时间线；
- 是否出现空泛或公关式表述；
- 是否保留关键限制条件；
- 是否加入报道中不存在的事实。

CI 只验证 fixture parsing 与 production contract 复用，不访问真实模型服务。
