import { defineModule } from "@aihot/contracts/modules";
export const rankings = defineModule({ name: "rankings", pages: [{ path: "rankings", file: "web/page.tsx" }], apiPaths: [/^\/api\/site\/rankings(?:\/|$)/] });
