// Recognition of Tibo's posts: the model translates and states what the post claims; code checks
// the boundaries (kinds, actions, times, relations) independent of wording.
import { z } from "zod";
import { SITE } from "@aihot/industry/site";
import { modelFor } from "../editorial/models.ts";
import { chatJson } from "../providers/llm.ts";
import { pacificParts } from "./time.ts";

export const RECOGNIZE_PROMPT_VERSION = "tibo-reset-2026-09-26.5";

export interface ContextInput {
  id: string;
  author: string;
  relation: "reply" | "quote";
  text: string;
  publishedAt: string | null;
}

export interface OpenEventInput {
  id: string;
  kind: "direct_reset" | "reset_credit";
  status: "announced" | "confirmed";
  firstPostAt: string;
  excerpt: string;
  schedule: string | null;
}

const SYSTEM = `你是 ${SITE.name} 的“Tibo 重置监控”识别器。Tibo（@thsottiaux）是 OpenAI Codex 负责人，常在 X 上宣布 Codex 用量额度重置或发放“重置卡”。你读一条他的帖子（含回复/引用上下文），输出严格 JSON。

判断要点：
- direct_reset（额度重置）：直接把用户的 Codex / ChatGPT Work 用量额度清零恢复满额，如 “we'll reset usage limits”“All reset for everyone”“reset landing at 6pm”。
- reset_credit（重置卡 / banked reset）：往账户里放一张可自行使用的重置卡，如 “loading a banked reset into all accounts”“credit every user with a BANKED reset”“you will get more manual resets”（用户自己手动触发的重置也是重置卡）。
- 只说 “a reset”“reset is landing” 而看不出是哪种形式时，kind 仍按最可能的一种填，但 kindExplicit=false。
- action：announce=承诺将要重置/发卡；progress=正在下发、尚未完成；confirm=已经完成/已到账（“Reset all propagated”“has landed”）；amend=对已宣布事件补充适用范围或时间；withdraw=撤回或取消。
- 简短回复（如 “Yes”“Soon”“Not so random, but yes”）要结合被回复的问题判断，被回复的内容与重置无关时不产生命题：问“会不会/什么时候重置”→ announce；问“是不是刚刚重置了”→ confirm。
- count：这一句承诺或确认了几次重置（“reset twice” = 2），默认 1。
- 同一条帖子里，每次重置只输出一个命题：对已经提到的重置再次提及、解释原因（如 “We're resetting usage twice so people can keep experimenting” 是在解释前面宣布的两次重置）不另起命题。
- real：这是不是 Tibo 真实作出的承诺或确认。泛泛描述惯例或政策（“that includes the occasional reset”“we reset from time to time”）、谈改进下发速度或机制（“we are working to reduce this to a few minutes”）都不是承诺，real=false。
- 下发进度（“rolling out”“50% done”“And now 100%”“still propagating”）属于最近那次重置：未完成用 progress，说完成（100%/all done）用 confirm，relatesTo 指向它。宣布（“we will reset…”“reset landing at 6pm”）和完成确认（“All reset for everyone.”“Reset all propagated.”“The banked reset has landed”“Not so random, but yes” 回答“刚刚是不是重置了”）都是 true；玩笑、假设、提问、条件句（“if we…”）、否认或“没有重置”才是 false。
- relatesTo：只有当这条是在确认、推进、补充或撤回“待关联事件”里某件**尚未完成**的宣布（或同一次重置的补充说明）时，才填那件事的 id。确认一次新的、不同的重置（例如之前那次早已确认完成）时填 null；新的一次宣布也填 null。
- statedTime：只描述原话，不要自己换算日期时间（代码会按发帖时间计算）。Tibo 说的 PST/PT 一律是太平洋当地时间。
  · 相对说法填 relativeHours（从发帖时起算的小时数）：“in the next hour” → deadline, relativeHours=1；“in the next few hours” → deadline, 3；“over the next 24 hours” → deadline, 24；“in about an hour” → approximate, 1；“in ~3 hours” → approximate, 3；“shortly/soon” → approximate, 1。
  · 时段填 period：“this afternoon” → afternoon；“this evening” → evening；“tonight” → tonight；“end of day/by midnight/today” → end_of_day（precision=deadline）。
  · 钟点填 clock（HH:mm，24 小时制，如 6pm → 18:00），给了起止时 clockThrough；precision=exact（单个钟点）或 window（起止）。
  · 只给日期（如 “on Tuesday”“tomorrow”）填 dayOffset（相对发帖当天的太平洋日期差，tomorrow=1，下周二按实际相差天数），precision=date；钟点或时段也可以同时带 dayOffset。
  · 没说时间填 null。
- expectedLanding：仅对 announce/progress 给出你估计的落地窗口（太平洋时间 "YYYY-MM-DD HH:mm"），参考他以往：宣布后多在数小时内落地，常在太平洋时间 16:30–21:30 按下；不得早于原话时间。note 用一句中文说明依据。
- scope：audienceSource 保留原文的适用对象（如 "all paid users"，含条件）；plans 为套餐名数组（如 ["Plus","Pro","Business"]），未说明为 null；audienceZh 为中文展示（如 “所有付费用户”），陌生条件保留英文引号；productsZh 如 “Codex、ChatGPT Work”，未说明为 null。
- outage：帖子承认 Codex 故障填 "outage"，宣布恢复填 "recovery"，否则 null。
- relevant：帖子（结合上下文）是否与额度重置、重置卡或 Codex 故障有实质关系。无关帖子 propositions 为空、translationZh 可为 null。
- translationZh：相关帖子给出整条帖子的忠实中文全译（保留换行、@ 与链接，不增删）；contextZh 给每条上下文的中文全译。
- excerpt 是原帖中表达该命题的原句，excerptZh 是它的中文译文。
- 不要编造未出现的时间、对象或数量；不确定时 needsReview=true。

只输出 JSON：{"relevant":bool,"translationZh":string|null,"contextZh":[{"id":string,"textZh":string}],"outage":"outage"|"recovery"|null,"needsReview":bool,"propositions":[{"kind":"direct_reset"|"reset_credit","kindExplicit":bool,"action":"announce"|"progress"|"confirm"|"amend"|"withdraw","real":bool,"count":number,"relatesTo":string|null,"excerpt":string,"excerptZh":string,"statedTime":{"precision":"exact"|"approximate"|"deadline"|"date"|"window","relativeHours":number|null,"period":"afternoon"|"evening"|"tonight"|"end_of_day"|null,"clock":string|null,"clockThrough":string|null,"dayOffset":number|null}|null,"timeInferred":bool,"expectedLanding":{"earliestPacific":string,"latestPacific":string,"note":string}|null,"scope":{"audienceSource":string|null,"plans":string[]|null,"audienceZh":string|null,"productsZh":string|null}}]}`;

const PropositionSchema = z.object({
  kind: z.enum(["direct_reset", "reset_credit"]),
  kindExplicit: z.boolean().catch(false),
  action: z.enum(["announce", "progress", "confirm", "amend", "withdraw"]),
  real: z.boolean(),
  count: z.number().int().min(1).max(5).default(1),
  relatesTo: z.string().nullable().catch(null),
  excerpt: z.string(),
  excerptZh: z.string().catch(""),
  statedTime: z
    .object({
      precision: z.enum(["exact", "approximate", "deadline", "date", "window"]),
      relativeHours: z.number().min(0).max(240).nullable().catch(null),
      period: z.enum(["afternoon", "evening", "tonight", "end_of_day"]).nullable().catch(null),
      clock: z.string().regex(/^\d{2}:\d{2}$/).nullable().catch(null),
      clockThrough: z.string().regex(/^\d{2}:\d{2}$/).nullable().catch(null),
      dayOffset: z.number().int().min(-1).max(14).nullable().catch(null),
    })
    .nullable()
    .catch(null),
  timeInferred: z.boolean().catch(false),
  expectedLanding: z.object({ earliestPacific: z.string(), latestPacific: z.string(), note: z.string() }).nullable().catch(null),
  scope: z
    .object({
      audienceSource: z.string().nullable().catch(null),
      plans: z.array(z.string()).nullable().catch(null),
      audienceZh: z.string().nullable().catch(null),
      productsZh: z.string().nullable().catch(null),
    })
    .catch({ audienceSource: null, plans: null, audienceZh: null, productsZh: null }),
});

export const RecognitionSchema = z.object({
  relevant: z.boolean(),
  translationZh: z.string().nullable().catch(null),
  contextZh: z.array(z.object({ id: z.string(), textZh: z.string() })).catch([]),
  outage: z.enum(["outage", "recovery"]).nullable().catch(null),
  needsReview: z.boolean(),
  propositions: z.array(PropositionSchema),
});

export type Recognition = z.infer<typeof RecognitionSchema> & { model: string; promptVersion: string; receiptId: number };
export type Proposition = z.infer<typeof PropositionSchema>;

function describeTime(iso: string): string {
  const p = pacificParts(new Date(iso));
  return `${iso}（太平洋时间 ${p.date} ${p.hm}）`;
}

export async function recognizePost(input: { id: string; text: string; publishedAt: string; context: ContextInput[]; openEvents: OpenEventInput[] }): Promise<Recognition> {
  const lines = [
    `帖子 ${input.id}，发布于 ${describeTime(input.publishedAt)}：`,
    input.text,
    "",
    input.context.length ? "上下文（按关系列出）：" : "上下文：无",
    ...input.context.map((c) => `- [${c.relation === "quote" ? "被引用" : "被回复"}] ${c.id} @${c.author}${c.publishedAt ? `，${describeTime(c.publishedAt)}` : ""}：${c.text}`),
    "",
    input.openEvents.length ? "待关联事件（最近的已宣布或刚确认的事件）：" : "待关联事件：无",
    ...input.openEvents.map((e) => `- ${e.id}｜${e.kind}｜${e.status}｜首帖 ${describeTime(e.firstPostAt)}｜${e.schedule ?? "未给时间"}｜“${e.excerpt}”`),
  ];
  const res = await chatJson({
    model: await modelFor("monitor"),
    purpose: "monitor.recognize",
    subject: `x:${input.id}`,
    promptVersion: RECOGNIZE_PROMPT_VERSION,
    system: SYSTEM,
    user: lines.join("\n"),
    schema: RecognitionSchema,
    temperature: 0.1,
    maxTokens: 2500,
  });
  return { ...res.data, model: res.model, promptVersion: RECOGNIZE_PROMPT_VERSION, receiptId: res.receiptId };
}
