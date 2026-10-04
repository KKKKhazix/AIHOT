// Failure cases: a successful old response completes newer input; a failed business commit leaves
// an analysis or completed receipts behind; retry buys responses already saved before that failure.
import { gate, pointModels, stub, tag } from "./setup.ts";
import { analysisStep, SELECTING_SCORE } from "./analysis-steps.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { processArticle } from "@aihot/backend/jobs/content";
import { stopBoss } from "@aihot/backend/jobs/queue";

const sourceId = `analysis-consistency-${tag()}`;
let hold: { entered: ReturnType<typeof gate<void>>; release: ReturnType<typeof gate<void>> } | null = null;
const provider = await stub(async (_hit, request) => {
  const step = analysisStep(request.body);
  if (step === "prefilter" && hold) {
    const waiting = hold;
    waiting.entered.open();
    await waiting.release.promise;
  }
  const content = step === "prefilter" ? { label: "PASS", reason: "local fixture" }
    : step === "score" ? { attentionScore: SELECTING_SCORE }
    : step === "structure" ? { category: "ai-models", tags: [], subjects: [], scope: "single", fact: null }
    : { itemType: "model_release", authorRole: "principal", tags: ["模型发布"], editorialJudgment: "模型能力提升", titleZh: "实验室发布新模型", summaryZh: "实验室发布新模型，并公布了评测结果与价格。" };
  return { choices: [{ message: { content: JSON.stringify(content) } }] };
});
pointModels(provider.url);
before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,next_fetch_at)
    VALUES (${sourceId},'Analysis consistency','rss','T1','editorial','2100-01-01')`;
});
after(async () => { await stopBoss(); await provider.close(); await closeDb(); });

const material = (name: string) => ({ sourceId, url: `https://example.org/${sourceId}/${name}`, title: `A lab releases a model ${name}`,
  bodyText: `A lab released a model ${name}. ` + "The release includes benchmark results and pricing details. ".repeat(12),
  bodyStatus: "ok" as const, via: "fetch" as const, publishedAt: new Date() });

test("a late successful analysis preserves newer input awaiting processing", async () => {
  const input = material("stale-success");
  const { articleId } = await upsertMaterial(input);
  const waiting = { entered: gate(), release: gate() };
  hold = waiting;
  const pending = processArticle(articleId);
  await waiting.entered.promise;
  try {
    const revised = await upsertMaterial({ ...input, title: "The lab corrects the release", bodyText: "Corrected benchmark and pricing details. ".repeat(12) });
    assert.equal(revised.revised, true);
  } finally {
    hold = null;
    waiting.release.open();
  }
  const result = await pending;
  const [current] = await sql`SELECT revision,processing_state,processing_error FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...current }, { revision: 2, processing_state: "new", processing_error: null },
    "the recovery sweep must still see the new revision as unprocessed");
  assert.equal(result.state, "stale");
  const analyses = await sql`SELECT input_revision FROM analyses WHERE article_id=${articleId}`;
  assert.deepEqual(analyses.map(r => r.input_revision), [1], "the obsolete result is retained only against its original input");
  assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${articleId}`).length, 0);
});

test("a failed analysis commit rolls back its judgement and receipt completion; retry reuses the saved responses", async () => {
  const { articleId } = await upsertMaterial(material("atomic-commit"));
  const subject = `article:${articleId}@1`;
  await sql.unsafe(`CREATE FUNCTION reject_analysis_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.processing_state = 'analyzed' THEN RAISE EXCEPTION 'injected analysis commit failure'; END IF; RETURN NEW; END $$`);
  await sql.unsafe("CREATE TRIGGER reject_analysis_completion BEFORE UPDATE ON articles FOR EACH ROW EXECUTE FUNCTION reject_analysis_completion()");
  try {
    assert.equal((await processArticle(articleId)).state, "retrying");
  } finally {
    await sql.unsafe("DROP TRIGGER reject_analysis_completion ON articles");
    await sql.unsafe("DROP FUNCTION reject_analysis_completion()");
  }
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${articleId}`).length, 0, "a failed commit cannot leave a usable partial judgement");
  const received = await sql`SELECT id,status FROM receipts WHERE subject=${subject} ORDER BY id`;
  assert.ok(received.length > 0, "paid responses arrived before the business failure");
  assert.ok(received.every(r => r.status === "received"), "receipt completion rolls back with the judgement");
  const [failed] = await sql`SELECT processing_state,processing_error FROM articles WHERE id=${articleId}`;
  assert.equal(failed!.processing_state, "new");
  assert.match(failed!.processing_error, /injected analysis commit failure/);
  assert.equal((await sql`SELECT 1 FROM publications WHERE article_id=${articleId}`).length, 0);
  const hits = provider.hits();
  assert.equal((await processArticle(articleId)).state, "pass");
  assert.equal(provider.hits(), hits, "retry commits the persisted responses without buying them again");
  assert.equal((await sql`SELECT 1 FROM analyses WHERE article_id=${articleId}`).length, 1);
  const completed = await sql`SELECT id,status FROM receipts WHERE subject=${subject} ORDER BY id`;
  assert.deepEqual(completed.map(r => r.id), received.map(r => r.id));
  assert.ok(completed.every(r => r.status === "completed"));
  assert.deepEqual({ ...(await sql`SELECT selected, selection_candidate FROM publications WHERE article_id=${articleId}`)[0] },
    { selected: false, selection_candidate: true }, "saved analysis nominates a candidate while news identity is pending");
});
