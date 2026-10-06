// The story-digest evaluation (scripts/eval-story-digests.ts) is the check before a prompt change reaches every
// event, so two things are held: a case exported from an event is what the site itself sends (other reports,
// order, framing, system prompt, model or sampling would make the comparison meaningless), and nothing is
// paid for when the calls exceed the limit or the candidate cannot be compared.
import { pointModels, stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { composeStoryDigest } from "@aihot/backend/events/digest";
import { parseDigestEvalJsonl } from "../scripts/eval-story-digests-core.ts";

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
