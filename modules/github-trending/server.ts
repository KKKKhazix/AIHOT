import { defineServerModule } from "@aihot/backend/modules";
import { sql } from "@aihot/backend/db";
import { collectTrending, fetchViaProxy, pushToIngest } from "./collect.ts";
import type { Period } from "./parse.ts";
import { latestSnapshot, listCaptures, snapshotAt } from "./store.ts";

const run = (period: Period) => async () => {
  try {
    await collectTrending(period, { db: sql, fetchHtml: fetchViaProxy, push: pushToIngest });
  } catch (err) {
    console.error(`[github-trending] ${period} collect failed, previous snapshot kept:`, err);
    throw err;
  }
};

const PERIODS: Period[] = ["daily", "weekly", "monthly"];

const collecting = () => process.env.COLLECT_ENABLED === "true";

export default defineServerModule({
  name: "github-trending",
  schedules: [
    { name: "github-trending-daily", cron: "30 7 * * *", run: run("daily"), missed: "once", when: collecting },
    { name: "github-trending-weekly", cron: "0 9 * * 1", run: run("weekly"), missed: "once", when: collecting },
    { name: "github-trending-monthly", cron: "30 9 1 * *", run: run("monthly"), missed: "once", when: collecting },
  ],
  http(app) {
    app.get("/api/github-trending", async (req, reply) => {
      const q = req.query as { period?: string; history?: string; at?: string };
      const period = PERIODS.find((p) => p === q.period) ?? "daily";
      if (q.history === "1") return { period, captures: await listCaptures(sql, period) };
      const snap = q.at ? await snapshotAt(sql, period, q.at) : await latestSnapshot(sql, period);
      if (!snap) return reply.code(404).send({ error: "no snapshot yet" });
      return { period, ...snap };
    });
  },
});
