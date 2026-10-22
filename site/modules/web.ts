// What the site's modules add to the web pages (site/modules/index.ts).
import type { WebModule } from "@aihot/web/modules";
import githubDaily from "@aihot/github-daily/web";

export const WEB_MODULES: readonly WebModule[] = [githubDaily];
