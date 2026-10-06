// Failure modes: shutdown must report actual local jobs without their payloads, wait for them,
// stop accepting queued work, and distinguish queue drain completion from database shutdown.
import assert from "node:assert/strict";
import { test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";

test("queue drain reports concurrent work and waits without exposing payloads or taking another job", async (t) => {
  const boss = await getBoss();
  const names = ["test.drain", "cron.test.drain"];
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const logs: { msg?: string; phase?: string; elapsedMs?: number; count?: number; jobs?: { queue: string; count: number; oldestMs: number }[] }[] = [];
  let handled = 0;
  let drained = false;
  let stopping: Promise<void> | undefined;
  t.mock.method(console, "log", (line: string) => logs.push(JSON.parse(line)));
  try {
    for (const [index, name] of names.entries()) {
      await boss.createQueue(name);
      await boss.work(name, { localConcurrency: index === 0 ? 2 : 1, pollingIntervalSeconds: 0.5 }, async () => {
        if (++handled === 3) started.resolve();
        await release.promise;
      });
      for (let n = 0; n < (index === 0 ? 2 : 1); n++) await boss.send(name, { secret: "never-log-this-payload" });
    }
    await started.promise;
    await boss.send(names[0]!, { secret: "queued-not-started" });
    stopping = stopBoss().then(() => { drained = true; });
    const begin = logs.find(line => line.msg === "queue drain" && line.phase === "start");
    assert.ok(begin, "shutdown must identify what it is waiting for");
    assert.equal(begin.count, 3);
    assert.deepEqual(begin.jobs!.map(job => [job.queue, job.count]).sort(), [[names[1], 1], [names[0], 2]].sort());
    assert.ok(begin.jobs!.every(job => job.oldestMs >= 0));
    assert.equal(drained, false, "active handlers must finish before shutdown returns");
    release.resolve();
    await stopping;
    assert.equal(handled, 3, "shutdown must not start the queued fourth job");
    const end = logs.find(line => line.msg === "queue drain" && line.phase === "complete");
    assert.ok(end && end.elapsedMs! >= 0);
    assert.equal(end.count, 0);
    assert.doesNotMatch(JSON.stringify(logs), /never-log-this-payload|queued-not-started|secret/);
  } finally {
    release.resolve();
    await (stopping ?? stopBoss());
    await closeDb();
  }
});
