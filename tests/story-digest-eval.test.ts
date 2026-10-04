// The story-digest evaluation (scripts/eval-story-digests.ts). The ways it could mislead or cost money,
// each checked below:
// - a case exported from an event is not what the site sends: other reports (mentions, withdrawn ones),
//   another order (reports from the same moment), other evidence or title, another framing (first digest,
//   rewrite after a correction), another system prompt, model or sampling;
// - the export writes to the database or calls a model; an unknown, merged or empty event is skipped silently;
// - a candidate's placeholder or include is left unrendered; a candidate identical to the site's prompt
//   is paid for again;
// - more calls than allowed go out, or some go out before the limit is checked;
// - the site's and the candidate's answers are swapped between cases or prompts, or one failed call loses the others;
// - a call's usage or receipt is missing or wrong; a re-run pays again for answers already received;
// - the reports land outside the folder asked for.
import { pointModels, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { SITE } from "@aihot/site";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { DIGEST_PROMPT_VERSION, DIGEST_SYSTEM, buildStoryDigestInput, composeStoryDigest } from "@aihot/backend/events/digest";
import { promptText } from "@aihot/backend/editorial/prompts";
import { parseDigestEvalJsonl, toDigestInput } from "../scripts/eval-story-digests-core.ts";

const exec = promisify(execFile);
const key = `digest-eval-${tag()}`;
const now = new Date();
const at = (hours: number) => new Date(+now - hours * 3600_000);

after(async () => {
  await closeDb();
});

/** Runs the script against a provider stub; a refusal comes back as its exit code and output. */
async function run(args: string[], providerUrl: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, MODEL_CALLS_ENABLED: "true" };
  pointModels(providerUrl, ["deepseek-flash"], env);
  try {
    const { stdout, stderr } = await exec(process.execPath, ["scripts/eval-story-digests.ts", ...args], { cwd: REPO_ROOT, env, timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

const scratch = () => mkdtempSync(path.join(tmpdir(), "story-digest-eval-"));
const answer = (title: string, digest: string, tokens: [number, number]) => ({
  id: "local",
  choices: [{ message: { content: JSON.stringify({ title, digest }) } }],
  usage: { prompt_tokens: tokens[0], completion_tokens: tokens[1] },
});

async function source(suffix: string, tier: string) {
  const id = `${key}-${suffix}`;
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,config,first_party,next_fetch_at)
    VALUES (${id},${`来源 ${suffix}`},'rss',${tier},'editorial',${sql.json({})},${tier === "T1"},'2100-01-01')`;
  return id;
}

async function story(title: string) {
  const [s] = await sql<{ id: number; public_id: string }[]>`
    INSERT INTO stories (public_id,title,first_report_at,latest_at) VALUES (${randomUUID()},${title},${at(100)},${at(0)}) RETURNING id, public_id::text`;
  const [f] = await sql<{ id: number }[]>`INSERT INTO facts (public_id,story_id,title,subject,action,object,conditions)
    VALUES (${`f-${randomUUID()}`},${s!.id},${title},'Acme','发布','Atlas','仅限首批客户') RETURNING id`;
  return { id: Number(s!.id), publicId: s!.public_id, factId: Number(f!.id) };
}

async function report(sourceId: string, group: Awaited<ReturnType<typeof story>>, opts: { suffix: string; title: string; hours: number; role?: string; visibility?: string }) {
  const id = `${key}-${opts.suffix}`;
  const date = at(opts.hours);
  await sql`INSERT INTO articles (id,source_id,identity_key,url,title,timeline_at,discovered_at,published_at)
    VALUES (${id},${sourceId},${id},${`https://example.org/${id}`},${opts.title},${date},${date},${date})`;
  const [a] = await sql<{ id: number }[]>`INSERT INTO analyses (article_id,input_revision,origin,relevance,title_zh,summary_zh,score,selected,output)
    VALUES (${id},1,'rule','pass',${opts.title},${opts.title},70,true,
      ${sql.json({ fact: { evidence: `${opts.title} 原文`, conditions: [{ text: "仅限首批客户", quote: "first customers only" }] } })}) RETURNING id`;
  await sql`INSERT INTO publications (article_id,analysis_id,source_id,title,summary,url,channel,first_party,timeline_at,discovered_at,published_at,sort_at,
    story_id,fact_id,selected,eligible,visible_after,tags,body_mode,score,visibility)
    VALUES (${id},${a!.id},${sourceId},${opts.title},${`${opts.title} 的摘要`},${`https://example.org/${id}`},'news',true,${date},${date},${date},${date},
    ${group.id},${group.factId},true,true,${date},${[key]},'full',70,${opts.visibility ?? "public"})`;
  await sql`INSERT INTO fact_articles (fact_id,article_id,role,evidence) VALUES (${group.factId},${id},${opts.role ?? "report"},${`${opts.title} 的证据`})`;
  return id;
}

async function storyState(storyId: number) {
  const [row] = await sql<{ digest: string | null; version: number; versions: number }[]>`
    SELECT digest, version, (SELECT count(*) FROM story_digests WHERE story_id = s.id) AS versions FROM stories s WHERE id = ${storyId}`;
  return { ...row! };
}

test("a case exported from an event reaches the model exactly as the site's own digest request", async (t) => {
  const bodies: string[] = [];
  // An empty title keeps the event's title, so later steps read the same event the export read.
  const provider = await stub((_hit, req) => {
    bodies.push(req.body);
    return answer("", "Acme 已向首批客户开放 Atlas 有限测试。", [100, 20]);
  });
  pointModels(provider.url, ["deepseek-flash"]);
  const dir = scratch();
  t.after(async () => {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const official = await source("official", "T1");
  const media = await source("media", "T2");
  const g = await story("Acme 发布 Atlas");
  const first = await report(official, g, { suffix: "first", title: "Acme 发布 Atlas", hours: 30 });
  // Two reports from the same moment: the site keeps the order it read them in.
  await report(media, g, { suffix: "B", title: "同一时刻的报道 B", hours: 10 });
  await report(media, g, { suffix: "a", title: "同一时刻的报道 a", hours: 10 });
  await report(media, g, { suffix: "mention", title: "MENTION ONLY", hours: 5, role: "mention" });
  await report(media, g, { suffix: "withdrawn", title: "WITHDRAWN REPORT", hours: 4, visibility: "withdrawn" });

  for (const step of ["first digest", "rewrite after a correction"] as const) {
    if (step === "rewrite after a correction") await sql`UPDATE publications SET summary = '已经更正的摘要' WHERE article_id = ${first}`;
    const snapshot = path.join(dir, `${step.replace(/\W+/g, "-")}.jsonl`);
    const before = await storyState(g.id);
    const exported = await run(["--stories", g.publicId.toUpperCase(), "--out", snapshot], provider.url);
    assert.equal(exported.code, 0, exported.stderr);
    assert.equal(bodies.length, step === "first digest" ? 0 : 2, `${step}: exporting calls no model`);
    assert.deepEqual(await storyState(g.id), before, `${step}: exporting writes nothing`);
    const [row] = parseDigestEvalJsonl(readFileSync(snapshot, "utf8"));
    assert.equal(row!.caseId, g.publicId);
    assert.equal(row!.reports.length, 3, `${step}: mentions and withdrawn reports are not evidence`);
    assert.equal(row!.inputMode, step === "first digest" ? "incremental" : "corrected");

    assert.equal((await composeStoryDigest(g.id)).updated, true);
    const site = bodies.at(-1)!;
    assert.ok(step === "first digest" ? site.includes("【新】") : site.includes("经过更正") && site.includes("已经更正的摘要"), step);
    const evaluated = await run(["--cases", snapshot, "--out-dir", dir], provider.url);
    assert.equal(evaluated.code, 0, evaluated.stderr);
    assert.equal(bodies.at(-1), site, `${step}: model, system prompt, input and sampling are the site's, byte for byte`);
  }
});

test("the export names the events it cannot read instead of skipping them", async (t) => {
  const provider = await stub(() => answer("", "不应调用", [1, 1]));
  const dir = scratch();
  t.after(async () => {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const s = await source("refusals", "T1");
  const kept = await story("合并后的事件");
  await report(s, kept, { suffix: "kept", title: "保留的报道", hours: 3 });
  const merged = await story("已被合并的事件");
  await sql`UPDATE stories SET merged_into = ${kept.id} WHERE id = ${merged.id}`;
  const empty = await story("没有公开报道的事件");
  const unknown = randomUUID();
  const out = path.join(dir, "cases.jsonl");

  const missing = await run(["--stories", `${kept.publicId},${merged.publicId},${unknown}`, "--out", out], provider.url);
  assert.notEqual(missing.code, 0);
  assert.ok(missing.stderr.includes(merged.publicId) && missing.stderr.includes(unknown), missing.stderr);
  assert.ok(!missing.stderr.includes(kept.publicId), "only the events it cannot read are named");
  const bare = await run(["--stories", empty.publicId, "--out", out], provider.url);
  assert.notEqual(bare.code, 0);
  assert.ok(bare.stderr.includes(empty.publicId), bare.stderr);
  const malformed = await run(["--stories", "not-an-id", "--out", out], provider.url);
  assert.notEqual(malformed.code, 0);
  assert.ok(malformed.stderr.includes("not-an-id"), malformed.stderr);
  assert.equal(existsSync(out), false, "no partial snapshot");
  assert.equal(provider.hits(), 0);
});

const evalCase = (caseId: string, title: string) => ({
  caseId,
  story: { title, previousDigest: null },
  inputMode: "incremental",
  knownArticleIds: [],
  reports: [{
    id: `${caseId}-r1`,
    publishedAt: "2026-09-01T09:00:00+08:00",
    source: "Acme",
    firstParty: true,
    title: `${title}的报道`,
    summary: "Acme 向首批客户开放 Atlas 有限测试。",
    fact: { id: 1, subject: "Acme", action: "开放", object: "Atlas", conditions: "仅限首批客户", evidence: "首批客户本月开始试用", structured: null },
  }],
});

test("a candidate prompt runs beside the site's on the same input, each call with its own receipt and usage", async (t) => {
  const marker = `候选-${tag()}`;
  const bodies: Array<{ system: string; user: string }> = [];
  let failCandidateTwo = true;
  const provider = await stub((_hit, req) => {
    const messages = (JSON.parse(req.body) as { messages: Array<{ content: string }> }).messages;
    const [system, user] = [messages[0]!.content, messages[1]!.content];
    bodies.push({ system, user });
    const live = system === DIGEST_SYSTEM;
    const title = /事件当前标题：(.+)/.exec(user)![1]!;
    if (!live && title.includes("二号") && failCandidateTwo) {
      failCandidateTwo = false;
      return { choices: [{ message: { content: "not JSON" } }], usage: { prompt_tokens: 7, completion_tokens: 1 } };
    }
    return live ? answer("线上标题", `线上综述：${title}，长度足够。`, [100, 10]) : answer("候选标题", `候选综述：${title}，长度足够。`, [200, 20]);
  });
  const dir = scratch();
  t.after(async () => {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const cases = path.join(dir, "cases.jsonl");
  writeFileSync(cases, [evalCase(`${marker}-1`, "Atlas 一号事件"), evalCase(`${marker}-2`, "Atlas 二号事件")].map((row) => JSON.stringify(row)).join("\n"));
  const candidate = path.join(dir, "candidate.md");
  writeFileSync(candidate, `你是 {{siteName}} 的事件编辑（${marker}）。\n{{> rules-anti-hallucination}}\n只输出 JSON：{"title": "...", "digest": "..."}\n`);
  const out = path.join(dir, "reports");

  interface Call { title: string | null; digest: string | null; receiptId: number | null; reused: boolean; tokensIn: number; tokensOut: number; error: string | null }
  interface Report {
    meta: { prompts: { live: { version: string }; candidate: { version: string } } };
    models: Record<string, { summary: { live: { tokensIn: number; errors: number }; candidate: { tokensIn: number; errors: number } }; cases: Array<{ caseId: string; live: Call; candidate: Call }> }>;
  }
  const evaluate = async () => {
    const result = await run(["--cases", cases, "--system", candidate, "--models", "deepseek-flash", "--out-dir", out], provider.url);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /calls: 4\b/);
    const file = result.stdout.split("\n").find((line) => line.startsWith("report: "))!.slice(8);
    const markdown = result.stdout.split("\n").find((line) => line.startsWith("markdown: "))!.slice(10);
    assert.deepEqual([path.dirname(file), path.dirname(markdown)], [out, out]);
    return { report: JSON.parse(readFileSync(file, "utf8")) as Report, markdown: readFileSync(markdown, "utf8") };
  };

  const cold = await evaluate();
  assert.equal(provider.hits(), 4);
  const candidateSystem = bodies.find((body) => body.system !== DIGEST_SYSTEM)!.system;
  assert.ok(candidateSystem.includes(`你是 ${SITE.name} 的事件编辑（${marker}）`) && candidateSystem.includes(promptText("rules-anti-hallucination")));
  assert.ok(!candidateSystem.includes("{{"), "placeholders and includes render as in the site's prompts");
  for (const title of ["Atlas 一号事件", "Atlas 二号事件"]) {
    const users = new Set(bodies.filter((body) => body.user.includes(title)).map((body) => body.user));
    assert.equal(users.size, 1, "both prompts get the same input");
  }
  assert.equal(cold.report.meta.prompts.live.version, DIGEST_PROMPT_VERSION);
  assert.notEqual(cold.report.meta.prompts.candidate.version, DIGEST_PROMPT_VERSION);
  const run1 = cold.report.models["deepseek-flash"]!;
  const [one, two] = run1.cases;
  assert.equal(one!.live.digest, "线上综述：Atlas 一号事件，长度足够。");
  assert.equal(one!.candidate.digest, "候选综述：Atlas 一号事件，长度足够。");
  assert.equal(two!.live.digest, "线上综述：Atlas 二号事件，长度足够。");
  assert.equal(two!.candidate.digest, null);
  assert.match(two!.candidate.error!, /unusable output/);
  const calls = [one!.live, one!.candidate, two!.live, two!.candidate];
  assert.equal(new Set(calls.map((call) => call.receiptId)).size, 4, "every call has its own receipt, the failed one included");
  assert.ok(calls.every((call) => call.receiptId !== null && !call.reused));
  assert.deepEqual(calls.map((call) => [call.tokensIn, call.tokensOut]), [[100, 10], [200, 20], [100, 10], [7, 1]]);
  assert.deepEqual([run1.summary.live.tokensIn, run1.summary.candidate.tokensIn, run1.summary.candidate.errors], [200, 207, 1]);
  for (const text of ["线上综述：Atlas 一号事件", "候选综述：Atlas 一号事件", "线上综述：Atlas 二号事件", "unusable output", `#${one!.candidate.receiptId}`]) {
    assert.ok(cold.markdown.includes(text), `the Markdown shows ${text}`);
  }

  const warm = await evaluate();
  assert.equal(provider.hits(), 5, "a re-run pays only for the answer it did not receive");
  const run2 = warm.report.models["deepseek-flash"]!;
  const again = [run2.cases[0]!.live, run2.cases[0]!.candidate, run2.cases[1]!.live, run2.cases[1]!.candidate];
  assert.deepEqual(again.map((call) => call.receiptId), calls.map((call) => call.receiptId));
  assert.deepEqual(again.map((call) => call.reused), [true, true, true, false]);
  assert.equal(run2.cases[1]!.candidate.digest, "候选综述：Atlas 二号事件，长度足够。");
  assert.deepEqual([again[3]!.tokensIn, run2.summary.candidate.errors], [207, 0], "usage counts the unusable attempt too");
});

test("nothing is sent when the calls exceed the limit or the candidate cannot be compared", async (t) => {
  const provider = await stub(() => answer("", "不应调用的综述文字。", [1, 1]));
  const dir = scratch();
  t.after(async () => {
    await provider.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const marker = tag();
  const write = (name: string, text: string) => {
    const file = path.join(dir, name);
    writeFileSync(file, text);
    return file;
  };
  const two = write("two.jsonl", [1, 2].map((n) => JSON.stringify(evalCase(`${marker}-${n}`, `事件 ${n}`))).join("\n"));
  const ten = write("ten.jsonl", Array.from({ length: 10 }, (_, n) => JSON.stringify(evalCase(`${marker}-ten-${n}`, `事件 ${n}`))).join("\n"));
  const candidate = write("candidate.md", "你是 {{siteName}} 的事件编辑。只输出 JSON：{\"title\": \"...\", \"digest\": \"...\"}\n");
  const unknownValue = write("unknown.md", "你是 {{siteName}} 的事件编辑，服务 {{audience}}。\n");
  const same = path.join(dir, "same.md");
  copyFileSync(path.join(REPO_ROOT, "industry/prompts/story-digest.md"), same);

  const over = await run(["--cases", two, "--system", candidate, "--max-calls", "3", "--out-dir", dir], provider.url);
  assert.notEqual(over.code, 0);
  assert.match(over.stdout + over.stderr, /\b4\b.*--max-calls 3/s);
  const overDefault = await run(["--cases", ten, "--system", candidate, "--out-dir", dir], provider.url);
  assert.notEqual(overDefault.code, 0);
  assert.match(overDefault.stdout + overDefault.stderr, /\b20\b.*--max-calls 18/s, "the default limit is 18 calls");
  const unrendered = await run(["--cases", two, "--system", unknownValue, "--out-dir", dir], provider.url);
  assert.notEqual(unrendered.code, 0);
  assert.match(unrendered.stderr, /\{\{audience\}\}/);
  const identical = await run(["--cases", two, "--system", same, "--out-dir", dir], provider.url);
  assert.notEqual(identical.code, 0);
  assert.match(identical.stderr, /same as the site's prompt/);
  assert.equal(provider.hits(), 0);
  assert.deepEqual(readdirSync(dir).filter((name) => name.startsWith("story-digests-")), [], "no report for a run that did not start");
});

test("hand-written cases parse strictly and keep the site's two input forms", () => {
  const row = evalCase("case-a", "Atlas 测试扩大");
  const value = {
    ...row,
    story: { title: "Atlas 测试扩大", previousDigest: "上一版综述" },
    knownArticleIds: ["old"],
    reports: [
      { ...row.reports[0]!, id: "new", publishedAt: "2026-09-02T09:00:00+08:00", title: "测试扩大", fact: { ...row.reports[0]!.fact, id: 2, conditions: "仍属于有限测试" } },
      { ...row.reports[0]!, id: "old", publishedAt: "2026-09-01T09:00:00+08:00", title: "首次开放" },
    ],
  };
  const line = JSON.stringify(value);
  assert.throws(() => parseDigestEvalJsonl(`${line}\n${line}`), /duplicate caseId case-a/);
  assert.throws(() => parseDigestEvalJsonl(JSON.stringify({ ...value, reports: [] })), /line 1/);
  assert.equal(parseDigestEvalJsonl(`// a comment\n\n${line}`).length, 1);

  const incremental = toDigestInput(parseDigestEvalJsonl(line)[0]!);
  assert.deepEqual(incremental.reports.map((report) => report.id), ["old", "new"], "oldest first, as the site reads them");
  const sameMoment = { ...value, reports: [{ ...value.reports[0]!, id: "z" }, { ...value.reports[0]!, id: "A" }] };
  assert.deepEqual(toDigestInput(parseDigestEvalJsonl(JSON.stringify(sameMoment))[0]!).reports.map((report) => report.id), ["z", "A"],
    "reports from the same moment keep the snapshot's order, which is the database's");
  const update = buildStoryDigestInput(incremental.story, incremental.reports, incremental);
  assert.match(update, /上一版综述：上一版综述/);
  assert.match(update, /【新】报道 new｜事实 2/);
  assert.doesNotMatch(update, /【新】报道 old/);
  assert.match(update, /仍属于有限测试/);

  const corrected = toDigestInput(parseDigestEvalJsonl(JSON.stringify({ ...value, inputMode: "corrected" }))[0]!);
  const rewrite = buildStoryDigestInput(corrected.story, corrected.reports, corrected);
  assert.match(rewrite, /经过更正/);
  assert.doesNotMatch(rewrite, /上一版综述|【新】/);
});
