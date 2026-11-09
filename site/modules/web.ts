// What the site's modules add to the web pages (site/modules/index.ts).
import type { WebModule } from "@aihot/web/modules";

import { rankingsWeb } from "../../modules/rankings/web.tsx";
export const WEB_MODULES: readonly WebModule[] = [rankingsWeb];
