import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "github-daily",
  pages: [{ path: "github-daily", file: "page.tsx" }],
  apiPaths: [/^\/api\/github-daily(?:\/|$)/],
});
