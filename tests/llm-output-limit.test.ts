import { stub, tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { z } from "zod";
import { closeDb, sql } from "@aihot/backend/db";
import { chatJson, ModelOutputError } from "@aihot/backend/providers/llm";

let content = "";
let finishReason = "length";
const limits: number[] = [];
const provider = await stub((hit, req) => {
  limits.push(JSON.parse(req.body).max_tokens);
  return { id: `limit-${hit}`, choices: [{ finish_reason: finishReason,
    message: { content, reasoning_content: '{"ok":true}' } }],
    usage: { prompt_tokens: 10, completion_tokens: 1500, total_tokens: 1510 } };
});
Object.assign(process.env, { LLM_BASE_URL: `${provider.url}/v1`, LLM_API_KEY: "test-key", LLM_MODEL: "reasoning-model", LLM_EXTRA_JSON: "{}" });

const ask = (subject: string) => chatJson({ model: "default", purpose: "invariant_test", subject,
  promptVersion: "output-limit", system: "Return JSON", user: subject, schema: z.object({ ok: z.boolean() }) });

after(async () => {
  await provider.close();
  await closeDb();
});

test("unusable length-limited output explains the token limit in the error and receipt", async (t) => {
  for (const output of ["", '{"ok":']) {
    await t.test(output ? "truncated JSON" : "reasoning without an answer", async () => {
      content = output;
      finishReason = "length";
      const subject = `limit-${tag()}`;
      const before = provider.hits();
      let receiptId: number | null = null;
      await assert.rejects(ask(subject), (error: unknown) => {
        assert.ok(error instanceof ModelOutputError);
        receiptId = error.receiptId;
        assert.match(error.message, /finish_reason=length/);
        assert.match(error.message, /token limit/i);
        return true;
      });
      assert.equal(provider.hits() - before, 1, "diagnosing truncation does not retry the paid call");
      const [receipt] = await sql`SELECT status, error, response FROM receipts WHERE id = ${receiptId}`;
      assert.equal(receipt!.status, "failed");
      assert.match(receipt!.error, /finish_reason=length/);
      assert.equal(receipt!.response.choices[0].message.content, output, "the original answer is retained");
      assert.equal(receipt!.response.choices[0].message.reasoning_content, '{"ok":true}');
    });
  }
});

test("an empty stopped answer is not diagnosed as token exhaustion or replaced with reasoning", async () => {
  content = "";
  finishReason = "stop";
  await assert.rejects(ask(`empty-${tag()}`), (error: unknown) => {
    assert.ok(error instanceof ModelOutputError);
    assert.match(error.message, /No JSON object/);
    assert.doesNotMatch(error.message, /finish_reason=length/);
    return true;
  });
});

test("valid structured output remains usable even when the provider reports length", async () => {
  content = '{"ok":true}';
  finishReason = "length";
  assert.deepEqual((await ask(`valid-${tag()}`)).data, { ok: true });
});

test("an explicit token override reaches the provider and a valid answer is still reused", async () => {
  content = '{"ok":true}';
  finishReason = "stop";
  process.env.LLM_EXTRA_JSON = '{"max_tokens":10000}';
  const before = provider.hits();
  const subject = `override-${tag()}`;
  try {
    const first = await ask(subject);
    const second = await ask(subject);
    assert.deepEqual(first.data, { ok: true });
    assert.equal(limits.at(-1), 10000);
    assert.equal(second.receiptId, first.receiptId);
    assert.equal(second.reused, true);
    assert.equal(provider.hits() - before, 1);
  } finally {
    process.env.LLM_EXTRA_JSON = "{}";
  }
});
