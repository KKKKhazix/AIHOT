// Story digests on fixed cases, leaving every event as it is: the site's own digest request (system prompt,
// input builder, model route, sampling, receipts) and, with --system, a candidate system prompt on the same
// input beside it.
//   Export events as a snapshot of cases (reads the database, calls no model):
//     node --env-file=.env scripts/eval-story-digests.ts --stories <publicId,...> --out <file.jsonl>
//   Run the cases:
//     node --env-file=.env scripts/eval-story-digests.ts [--cases .data/story-digest-cases.jsonl] [--system <candidate.md>]
//       [--models default,deepseek-flash] [--max-calls 18] [--concurrency 4] [--out-dir .data/eval]
// The number of calls (cases × models × prompts) is printed first; above --max-calls nothing is sent.
// Receipts make an identical re-run free. The comparison is written to --out-dir as JSON and Markdown.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { promptFromText } from "@aihot/backend/editorial/prompts";
import { DIGEST_PROMPT_VERSION, DIGEST_SAMPLING, DIGEST_SYSTEM, DigestSchema, buildStoryDigestInput } from "@aihot/backend/events/digest";
import { sha256 } from "@aihot/backend/lib/ids";
import { ModelOutputError, chatJson } from "@aihot/backend/providers/llm";
import { ReceiptUnknownError, completeReceipt } from "@aihot/backend/providers/receipts";
import { digestReports } from "@aihot/backend/publication/story-evidence";
import {
  caseFromStory,
  digestComparisonMarkdown,
  inputForm,
  parseDigestEvalJsonl,
  toDigestInput,
  type DigestCall,
  type DigestEvalReport,
  type DigestPromptSummary,
} from "./eval-story-digests-core.ts";
import { evalModels, pmap, positiveInt, usageFor } from "./eval-tools.ts";

const { values } = parseArgs({
  options: {
    stories: { type: "string" },
    out: { type: "string" },
    cases: { type: "string", default: ".data/story-digest-cases.jsonl" },
    system: { type: "string" },
    models: { type: "string" },
    "max-calls": { type: "string", default: "18" },
    concurrency: { type: "string", default: "4" },
    "out-dir": { type: "string", default: ".data/eval" },
  },
});

const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function exportCases(list: string, out: string) {
  const ids = [...new Set(list.split(",").map((id) => id.trim().toLowerCase()).filter(Boolean))];
  if (!ids.length) throw new Error("--stories did not name any events");
  const malformed = ids.filter((id) => !PUBLIC_ID.test(id));
  if (malformed.length) throw new Error(`not an event id (the part of its address after /story/): ${malformed.join(", ")}`);
  // One read-only snapshot: nothing is written, and every event is read as of the same moment.
  const cases = await sql.begin("isolation level repeatable read read only", async (tx) => {
    const stories = await tx<{ id: number; public_id: string; title: string; has_digest: boolean }[]>`
      SELECT s.id, s.public_id::text, s.title, EXISTS (SELECT 1 FROM story_digests d WHERE d.story_id = s.id) AS has_digest
      FROM stories s WHERE s.public_id = ANY(${ids}::uuid[]) AND s.merged_into IS NULL`;
    const found = new Map(stories.map((story) => [story.public_id, story]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`no current event (unknown, or merged into another: use the id its page redirects to): ${missing.join(", ")}`);
    const reports = await digestReports(tx, stories.map((story) => story.id));
    const own = (story: { id: number }) => reports.filter((report) => report.story_id === story.id);
    const empty = stories.filter((story) => own(story).length === 0);
    if (empty.length) throw new Error(`no listed report to write a digest from: ${empty.map((story) => story.public_id).join(", ")}`);
    return ids.map((id) => {
      const story = found.get(id)!;
      return caseFromStory({ publicId: story.public_id, title: story.title, hasDigest: story.has_digest }, own(story));
    });
  });
  const file = path.resolve(REPO_ROOT, out);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${cases.map((row) => JSON.stringify(row)).join("\n")}\n`);
  for (const row of cases) console.log(`${row.caseId}  ${row.reports.length} reports  ${inputForm(row)}  ${row.story.title}`);
  console.log(`snapshot: ${file}`);
}

interface Prompt {
  key: "live" | "candidate";
  version: string;
  system: string;
}

async function evaluate() {
  const maxCalls = positiveInt(values["max-calls"]!, "max-calls");
  const concurrency = positiveInt(values.concurrency!, "concurrency");
  const rows = parseDigestEvalJsonl(readFileSync(path.resolve(REPO_ROOT, values.cases!), "utf8"));
  if (!rows.length) throw new Error("no digest evaluation cases");

  const prompts: Prompt[] = [{ key: "live", version: DIGEST_PROMPT_VERSION, system: DIGEST_SYSTEM }];
  if (values.system) {
    const system = promptFromText(values.system, readFileSync(path.resolve(REPO_ROOT, values.system), "utf8"));
    if (system === DIGEST_SYSTEM) throw new Error(`${values.system} renders the same as the site's prompt: nothing to compare`);
    prompts.push({ key: "candidate", version: `candidate@${sha256(system).slice(0, 10)}`, system });
  }
  const models = await evalModels(values.models, "digest");
  const calls = rows.length * models.length * prompts.length;
  console.log(`calls: ${calls} = ${rows.length} case(s) × ${models.length} model(s) × ${prompts.length} prompt(s), limit ${maxCalls}`);
  if (calls > maxCalls) throw new Error(`${calls} calls exceed --max-calls ${maxCalls}: evaluate fewer cases, or raise the limit`);

  const report: DigestEvalReport = {
    meta: {
      createdAt: new Date().toISOString(),
      cases: values.cases!,
      calls,
      prompts: {
        live: { version: DIGEST_PROMPT_VERSION },
        ...(values.system ? { candidate: { file: values.system, version: prompts[1]!.version } } : {}),
      },
    },
    models: {},
  };
  for (const model of models) {
    const started = Date.now();
    const tasks = rows.flatMap((row) => prompts.map((prompt) => ({ row, prompt })));
    const results = await pmap(tasks, concurrency, async ({ row, prompt }) => {
      const input = toDigestInput(row);
      const user = buildStoryDigestInput(input.story, input.reports, input);
      let answer: { title: string; digest: string } | null = null;
      let receiptId: number | null = null;
      let reused = false;
      let error: string | null = null;
      try {
        const res = await chatJson({
          model,
          purpose: "eval_story_digest",
          subject: `story-digest-eval:${row.caseId}`,
          promptVersion: prompt.version,
          system: prompt.system,
          user,
          schema: DigestSchema,
          ...DIGEST_SAMPLING,
        });
        await completeReceipt(sql, res.receiptId);
        answer = res.data;
        receiptId = res.receiptId;
        reused = res.reused;
      } catch (failure) {
        receiptId = failure instanceof ModelOutputError || failure instanceof ReceiptUnknownError ? failure.receiptId : null;
        error = String(failure).slice(0, 500);
      }
      const call: DigestCall = {
        title: answer?.title ?? null,
        digest: answer?.digest ?? null,
        receiptId,
        reused,
        ...(await usageFor(receiptId === null ? [] : [receiptId])),
        error,
      };
      return { row, key: prompt.key, call };
    });

    const callOf = (row: (typeof rows)[number], key: Prompt["key"]) => results.find((result) => result.row === row && result.key === key)?.call;
    const summarize = async (key: Prompt["key"]): Promise<DigestPromptSummary> => {
      const own = results.filter((result) => result.key === key).map((result) => result.call);
      return {
        calls: own.length,
        succeeded: own.filter((call) => call.error === null).length,
        errors: own.filter((call) => call.error !== null).length,
        reused: own.filter((call) => call.reused).length,
        ...(await usageFor(own.flatMap((call) => (call.receiptId === null ? [] : [call.receiptId])))),
      };
    };
    const summary = {
      live: await summarize("live"),
      ...(values.system ? { candidate: await summarize("candidate") } : {}),
      wallSeconds: Math.round((Date.now() - started) / 1000),
    };
    console.log(JSON.stringify({ model, ...summary }));
    report.models[model] = {
      summary,
      cases: rows.map((row) => ({
        caseId: row.caseId,
        storyTitle: row.story.title,
        input: inputForm(row),
        reports: row.reports.length,
        live: callOf(row, "live")!,
        ...(values.system ? { candidate: callOf(row, "candidate")! } : {}),
      })),
    };
  }

  const outDir = path.resolve(REPO_ROOT, values["out-dir"]!);
  mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `story-digests-${Date.now()}`);
  writeFileSync(`${base}.json`, JSON.stringify(report, null, 2));
  writeFileSync(`${base}.md`, digestComparisonMarkdown(report));
  console.log(`report: ${base}.json`);
  console.log(`markdown: ${base}.md`);
}

try {
  if (values.stories === undefined) await evaluate();
  else if (!values.out) throw new Error("--stories needs --out <file> for the snapshot");
  else await exportCases(values.stories, values.out);
} finally {
  await closeDb();
}
