import { defineWebModule } from "@aihot/web/modules";
import { IconGithub } from "@aihot/web/components/icons";

export default defineWebModule({
  name: "github-daily",
  sidebar: { section: "内容", items: [{ to: "/github-daily", label: "GitHub 日榜", icon: IconGithub }] },
});
