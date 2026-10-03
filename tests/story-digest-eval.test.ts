import test from "node:test";
import assert from "node:assert/strict";
import { parseDigestEvalJsonl } from "../scripts/eval-story-digests-core.ts";
import {
  DIGEST_PROMPT_VERSION,
  StoryDigestSchema,
  storyDigestPromptContext,
} from "@aihot/backend/events/digest";

test("digest eval JSONL parses cases and rejects duplicate ids", () => {
  const one = JSON.stringify({
    caseId: "case-a",
    reports: [{
      id: "r1",
      publishedAt: "2026-09-01T09:00:00+08:00",
      source: "Acme",
      firstParty: true,
      title: "Launch",
      summary: "Initial report",
    }],
  });
  assert.equal(parseDigestEvalJsonl(one).length, 1);
  assert.throws(() => parseDigestEvalJsonl(`${one}\n${one}`), /duplicate digest eval caseId/);
});

test("story digest evaluator shares the production prompt contract", () => {
  const { user } = storyDigestPromptContext([
    {
      id: "r1",
      at: new Date("2026-09-01T01:00:00Z"),
      source_name: "Acme",
      first_party: true,
      title: "Launch",
      summary: "Initial report",
    },
  ]);
  assert.match(user, /请只依据下面这些报道的当前内容重写综述/);
  assert.match(user, /Acme（一手）｜Launch｜Initial report/);
  assert.match(DIGEST_PROMPT_VERSION, /^story-digest@[0-9a-f]{10}$/);
  assert.equal(StoryDigestSchema.safeParse({
    title: "Atlas",
    digest: "这是一个长度足够的事件综述。",
    latest: "测试范围扩大。",
  }).success, true);
});

test("incremental prompt marks only reports outside the known set", () => {
  const reports = [
    { id: "old", at: new Date("2026-09-01T01:00:00Z"), source_name: "A", first_party: true, title: "Old", summary: "old" },
    { id: "new", at: new Date("2026-09-02T01:00:00Z"), source_name: "B", first_party: false, title: "New", summary: "new" },
  ];
  const { user } = storyDigestPromptContext(reports, {
    incremental: true,
    knownIds: new Set(["old"]),
    previousDigest: "上一版综述",
  });
  assert.match(user, /上一版综述/);
  assert.doesNotMatch(user, /【新】.*Old/);
  assert.match(user, /【新】.*New/);
});
