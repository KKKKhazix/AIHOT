// Names in the site's own text (a summary, an event's overview, a report's paragraphs) link to the page
// about them: a model's page, a company's topic. Only the first mention on a page links, a longer name
// wins over a name inside it, and a Latin name must stand as a whole word.
import assert from "node:assert/strict";
import { test } from "node:test";
import { linkMentions, mentionedTargets, withoutSharedNames, type MentionRun, type MentionTarget } from "@aihot/contracts/mentions";

const targets: MentionTarget[] = [
  { href: "/models/opus", names: ["Claude Opus 5.5"] },
  { href: "/topics/anthropic", names: ["Anthropic", "Claude"] },
  { href: "/models/gpt", names: ["GPT-5.5"] },
  { href: "/topics/openai", names: ["OpenAI"] },
  { href: "/models/flash", names: ["DeepSeek V4.1 Flash"] },
  { href: "/models/m27", names: ["MiniMax M 2.7"] },
  { href: "/models/oss", names: ["gpt-oss-120b"] },
  { href: "/models/command", names: ["Command A"] },
  { href: "/topics/meta", names: ["Meta", "Meta AI"] },
  { href: "/topics/nvidia", names: ["英伟达"] },
  { href: "/models/k3", names: ["Kimi K3"] },
];

/** The linked runs of each text as "[name→href]" between plain strings. */
const show = (runs: MentionRun[][]) => runs.map((r) => r.map((x) => (typeof x === "string" ? x : `[${x.text}→${x.href}]`)).join(""));

test("the longest name wins, and only the first mention of each page links", () => {
  assert.deepEqual(show(linkMentions(["Anthropic 发布 Claude Opus 5.5，Claude 用户可以直接用。", "Claude Opus 5.5 比 GPT-5.5 便宜。"], targets)), [
    "[Anthropic→/topics/anthropic] 发布 [Claude Opus 5.5→/models/opus]，Claude 用户可以直接用。",
    "Claude Opus 5.5 比 [GPT-5.5→/models/gpt] 便宜。",
  ]);
});

test("a Latin name stands as a whole word; a Chinese one needs no boundary", () => {
  assert.deepEqual(show(linkMentions(["GPT-5.55 和 GPT-5.5-mini 不是 Metaverse 里的 Meta，Kimi K3.1 也不是。英伟达发布新卡。"], targets)), [
    "GPT-5.55 和 GPT-5.5-mini 不是 Metaverse 里的 [Meta→/topics/meta]，Kimi K3.1 也不是。[英伟达→/topics/nvidia]发布新卡。",
  ]);
});

test("a name followed by a Latin word is the start of a longer name and does not link", () => {
  assert.deepEqual(show(linkMentions(["Claude Code 和 GPT-5.5 Pro 更新，GPT-5.5 和 Claude 都在"], targets)), [
    "Claude Code 和 GPT-5.5 Pro 更新，[GPT-5.5→/models/gpt] 和 [Claude→/topics/anthropic] 都在",
  ]);
  assert.deepEqual(show(linkMentions(["英伟达 Kimi K3 合作，英伟达H200"], targets)), ["英伟达 [Kimi K3→/models/k3] 合作，英伟达H200"]);
  // A shorter name inside the longer one is part of it too, and its page still links at its next mention.
  const ali = [{ href: "/topics/qwen", names: ["阿里巴巴", "阿里云", "阿里"] }, { href: "/models/q", names: ["Qwen3.8-27B"] }];
  assert.deepEqual(show(linkMentions(["阿里巴巴 Qwen3.8-27B 开源，阿里云 Qwen3.8-27B 上线，阿里巴巴说"], ali)), [
    "阿里巴巴 [Qwen3.8-27B→/models/q] 开源，阿里云 Qwen3.8-27B 上线，[阿里巴巴→/topics/qwen]说",
  ]);
});

test("spaces and hyphens inside a name may differ from how the text writes it", () => {
  assert.deepEqual(show(linkMentions(["DeepSeek-V4.1-Flash 对比 MiniMax M2.7 和 GPT-OSS-120B"], targets)), [
    "[DeepSeek-V4.1-Flash→/models/flash] 对比 [MiniMax M2.7→/models/m27] 和 [GPT-OSS-120B→/models/oss]",
  ]);
});

test("a name without a version number must match its case exactly", () => {
  assert.deepEqual(show(linkMentions(["use the command a；Command A 上线"], targets)), ["use the command a；[Command A→/models/command] 上线"]);
});

test("a text links at most `perText` names; a name it has no room for links at its next mention", () => {
  assert.deepEqual(show(linkMentions(["OpenAI、Anthropic、Meta 和英伟达", "OpenAI 和英伟达"], targets, 2)), [
    "[OpenAI→/topics/openai]、[Anthropic→/topics/anthropic]、Meta 和英伟达",
    "OpenAI 和[英伟达→/topics/nvidia]",
  ]);
});

test("an address in the text is one link, short as X shows it, and no name inside it links", () => {
  const withZai = [...targets, { href: "/models/glm", names: ["Z.ai"] }];
  assert.deepEqual(show(linkMentions(["过去 6 个月，https://Z.ai 的用量增长 20 倍，Z.ai 领先。", "见 https://www.anthropic.com/research/components-of-agent-memory。"], withZai)), [
    "过去 6 个月，[Z.ai→https://Z.ai] 的用量增长 20 倍，[Z.ai→/models/glm] 领先。",
    "见 [anthropic.com/research/compon…→https://www.anthropic.com/research/components-of-agent-memory]。",
  ]);
});

test("missing texts keep their place", () => {
  assert.deepEqual(show(linkMentions([null, "OpenAI", undefined], targets)), ["", "[OpenAI→/topics/openai]", ""]);
});

test("a name two pages claim links to neither, but a shorter name inside it does not link there either", () => {
  const shared = withoutSharedNames([
    { href: "/models/a", names: ["Muse", "Muse Spark 1.3"] },
    { href: "/topics/meta", names: ["Meta", "muse"] },
  ]);
  assert.deepEqual(shared, [
    { href: "/models/a", names: ["Muse Spark 1.3"] },
    { href: "/topics/meta", names: ["Meta"] },
    { href: null, names: ["Muse", "muse"] },
  ]);
  const ali = withoutSharedNames([{ href: "/a", names: ["阿里巴巴"] }, { href: "/b", names: ["阿里巴巴"] }, { href: "/c", names: ["阿里"] }]);
  assert.deepEqual(show(linkMentions(["阿里巴巴发布，阿里说"], ali)), ["阿里巴巴发布，[阿里→/c]说"]);
});

test("a page is sent only the targets its texts name, with the names it found", () => {
  assert.deepEqual(mentionedTargets(["Claude Opus 5.5 发布，Anthropic 说"], targets), [
    { href: "/models/opus", names: ["Claude Opus 5.5"] },
    { href: "/topics/anthropic", names: ["Anthropic"] },
  ]);
});

// The api sends a page only the targets its texts name (mentionedTargets); the page links with those.
// A name that holds its place without linking ("阿里巴巴" before an English name) must reach the page too,
// or the page links the shorter name inside it.
test("a page linking with the targets sent for it links exactly as with the whole list", () => {
  const all = [...targets, { href: "/topics/qwen", names: ["阿里巴巴", "阿里云", "阿里"] }, { href: "/models/q", names: ["Qwen3.8-27B"] }];
  const pages = [
    ["阿里巴巴 Qwen3.8-27B 开源，阿里说"],
    ["阿里云 Qwen3.8-27B 上线", "阿里巴巴说 Claude Code 和 GPT-5.5 Pro 更新，GPT-5.5 和 Claude 都在"],
    ["GPT-5.55 和 GPT-5.5-mini 不是 Metaverse 里的 Meta，Kimi K3.1 也不是。"],
  ];
  for (const texts of pages) assert.deepEqual(show(linkMentions(texts, mentionedTargets(texts, all))), show(linkMentions(texts, all)), texts[0]);
  assert.deepEqual(show(linkMentions(pages[0], mentionedTargets(pages[0], all))), ["阿里巴巴 [Qwen3.8-27B→/models/q] 开源，[阿里→/topics/qwen]说"]);
});
