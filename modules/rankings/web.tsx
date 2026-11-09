import { defineWebModule } from "@aihot/web/modules";
import { IconChart } from "@aihot/web/components/icons";
export const rankingsWeb = defineWebModule({ name: "rankings", sidebar: { section: "内容", items: [{ to: "/rankings", label: "榜单大全", icon: IconChart, after: "/hot" }] } });
