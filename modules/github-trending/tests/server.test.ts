import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import githubTrending from "../server.ts";

const saved = process.env.COLLECT_ENABLED;

afterEach(() => {
  if (saved === undefined) delete process.env.COLLECT_ENABLED;
  else process.env.COLLECT_ENABLED = saved;
});

test("schedules follow COLLECT_ENABLED", () => {
  const schedules = githubTrending.schedules ?? [];
  assert.equal(schedules.length, 3);
  process.env.COLLECT_ENABLED = "false";
  for (const s of schedules) assert.equal(s.when?.(), false);
  process.env.COLLECT_ENABLED = "true";
  for (const s of schedules) assert.equal(s.when?.(), true);
});
