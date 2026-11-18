import { defineModule } from "@aihot/contracts/modules";

export const aiNewsModule = defineModule({
  name: "ai-news",
  pages: [{ path: "ai-news", file: "web/ai-news.tsx", id: "ai-news" }],
});
