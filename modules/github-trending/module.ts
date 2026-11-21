import { defineModule } from "@aihot/contracts/modules";

export default defineModule({
  name: "github-trending",
  apiPaths: [/^\/api\/github-trending(?:$|[/?])/],
});
