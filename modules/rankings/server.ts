import { defineServerModule } from "@aihot/backend/modules";
import { collectRankings } from "./backend/collect.ts";
import { loadRankings } from "./backend/publication.ts";
export const rankingsServer = defineServerModule({
  name: "rankings",
  http(app) { app.get("/api/site/rankings", async (_req, reply) => { reply.header("Cache-Control", "public, max-age=60"); return { boards: await loadRankings() }; }); },
  schedules: [{ name: "rankings.collect", cron: "10 * * * *", when: () => process.env.COLLECT_ENABLED === "true", run: collectRankings }],
});
