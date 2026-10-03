import { gate, stub, tag } from './setup.ts';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { sql, closeDb } from '@aihot/backend/db';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { publishArticle } from '@aihot/backend/publication/publish';

const T = tag();
const SOURCE = `test-translate-stop-${T}`;
let active: { asked: ReturnType<typeof gate<void>>; hold: ReturnType<typeof gate<void>>; calls: number; misaligned: boolean };
const provider = await stub(async (_hit, req) => {
  const { segments } = JSON.parse(JSON.parse(req.body).messages[1].content) as { segments: string[] };
  active.calls++;
  if (active.calls === 1) { active.asked.open(); await active.hold.promise; }
  const t = active.misaligned && segments.length === 2 ? [] : segments.map(() => `完整译文${T}`);
  return { id: 'stub', choices: [{ message: { content: JSON.stringify({ t }) } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
});

function runTranslation() {
  const script = `
    import { translatePending } from '@aihot/backend/editorial/translate';
    import { shutdownSignal } from '@aihot/backend/jobs/queue';
    import { closeDb } from '@aihot/backend/db';
    process.on('SIGTERM', () => { shutdownSignal.abort(); process.send({ stopped: true }); });
    try { process.send({ result: await translatePending({ limit: 1 }) }); }
    finally { await closeDb(); process.disconnect(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, MODEL_CALLS_ENABLED: 'true', DEEPSEEK_BASE_URL: `${provider.url}/v1`, DEEPSEEK_API_KEY: 'test-key', AIHOT_CREDENTIALS_DIR: '/nonexistent-test-credentials' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let result: any;
  let stderr = '';
  const stopped = gate();
  child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
  child.on('message', (message: any) => { if (message.stopped) stopped.open(); if (message.result) result = message.result; });
  const done = new Promise<any>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(result) : reject(new Error(`translation child exited ${code}: ${stderr}`)));
  });
  return { child, done, stopped: stopped.promise };
}

before(async () => {
  await sql`INSERT INTO sources (id,name,kind,tier,participation_mode,site_fulltext,next_fetch_at)
    VALUES (${SOURCE},'Translation shutdown','rss','T1','editorial',true,'2100-01-01')`;
});
after(async () => { await provider.close(); await stopBoss(); await closeDb(); });

for (const misaligned of [false, true]) test(`SIGTERM finishes the sent ${misaligned ? 'misaligned' : 'normal'} batch and resumes from its receipt`, async () => {
  active = { asked: gate(), hold: gate(), calls: 0, misaligned };
  const first = misaligned ? `First paragraph ${T}.` : `First paragraph ${T}. ${'English text '.repeat(170)}`;
  const second = misaligned ? `Second paragraph ${T}.` : `Second paragraph ${T}. ${'More English '.repeat(170)}`;
  const { articleId } = await upsertMaterial({ sourceId: SOURCE, url: `https://example.org/translation-shutdown-${T}/${misaligned}`, title: `Shutdown ${T}`, bodyHtml: `<p>${first}</p><p>${second}</p>`, bodyText: first + second, bodyStatus: 'ok', language: 'en', via: 'fetch', publishedAt: new Date(), discoveredAt: new Date(Date.now() + 86_400_000) });
  await sql`INSERT INTO analyses (article_id,input_revision,origin,relevance,category,title_zh,summary_zh,reason_zh,score,selected)
    VALUES (${articleId},1,'rule','pass','ai-models',${`终止测试${T}`},'摘要','理由',90,true)`;
  await publishArticle(articleId, { releasedAt: new Date(Date.now() - 60_000) });
  const interrupted = runTranslation();
  await Promise.race([active.asked.promise, interrupted.done.then(() => assert.fail('translation ended before a request'))]);
  interrupted.child.kill('SIGTERM');
  await interrupted.stopped;
  active.hold.open();
  assert.deepEqual(await interrupted.done, { done: [], quotes: 0 });
  assert.equal(active.calls, 1, 'no later fragment or half-batch starts after shutdown');
  const receiptRows = await sql`SELECT status,response FROM receipts WHERE purpose='translate_body' AND subject LIKE ${`article:${articleId}@1#%`}`;
  assert.equal(receiptRows.length, 1);
  assert.equal(receiptRows[0]!.status, 'received');
  assert.ok(receiptRows[0]!.response, 'the paid answer arrived and remains reusable');
  assert.equal((await sql`SELECT 1 FROM translation_attempts WHERE article_id=${articleId}`).length, 0, 'interruption does not consume attempts or become terminal');
  assert.equal((await sql`SELECT 1 FROM translations WHERE article_id=${articleId}`).length, 0, 'no partial translation prevents restart');
  const resumed = await runTranslation().done;
  assert.equal(resumed.done[0].status, 'translated');
  assert.equal(active.calls, misaligned ? 3 : 2, 'the first receipt is reused, only missing pieces are requested');
  const [translation] = await sql`SELECT complete,revision FROM translations WHERE article_id=${articleId}`;
  assert.deepEqual({ ...translation }, { complete: true, revision: 1 });
});
