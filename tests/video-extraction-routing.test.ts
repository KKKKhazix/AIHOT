// An explicit full-text preference or the web-list kind must not bypass the video-page exclusion.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { sql, closeDb } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { queueProcessing } from "@aihot/backend/jobs/content";
import { QUEUES, stopBoss } from "@aihot/backend/jobs/queue";

const T = tag();
after(async () => { await stopBoss(); await closeDb(); });

test("RSS and web entries that point to videos skip body extraction even when full text was requested", async () => {
  for (const [kind, requested] of [["rss", false], ["rss", true], ["web_list", false]] as const) {
    const sourceId = `video-routing-${kind}-${requested}-${T}`;
    await sql`INSERT INTO sources(id,name,kind,config,tier,participation_mode) VALUES (${sourceId},'Video routing',${kind},${sql.json({ fetchPublicContent: requested })},'T1','editorial')`;
    const url = `https://www.youtube.com/watch?v=${kind}${requested}${T}`;
    const { articleId } = await upsertMaterial({ sourceId, url, title: "A video announcement", excerpt: "A publisher-supplied description.", bodyStatus: "pending", via: "fetch" });
    const jobId = await queueProcessing(articleId);
    const [job] = await sql<{ name: string }[]>`SELECT name FROM pgboss.job WHERE id=${jobId!}`;
    assert.equal(job!.name, QUEUES.analyze, `${kind} ${requested}`);
  }
});
