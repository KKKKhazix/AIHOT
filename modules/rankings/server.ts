import { defineServerModule } from "@aihot/backend/modules";
import { collectRankings, collectWxRankings, collectTopRankings } from "./backend/collect.ts";
import { loadRankings } from "./backend/publication.ts";
import { screenRankings } from "./backend/screen.ts";
export const rankingsServer = defineServerModule({
  name: "rankings",
  http(app) { app.get("/api/site/rankings", async (_req, reply) => { reply.header("Cache-Control", "public, max-age=60"); return { boards: await loadRankings() }; }); },
  schedules: [{ name: "rankings.collect", cron: "10 * * * *", when: () => process.env.COLLECT_ENABLED === "true", run: collectRankings }, { name: "rankings.wxrank", cron: "20 * * * *", when: () => process.env.COLLECT_ENABLED === "true", run: collectWxRankings }, { name: "rankings.tophub", cron: "35 * * * *", when: () => process.env.COLLECT_ENABLED === "true", run: collectTopRankings }, { name: "rankings.screen", cron: "* * * * *", when: () => process.env.MODEL_CALLS_ENABLED === "true", run: screenRankings }],
});
