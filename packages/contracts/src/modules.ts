// What a module (modules/<name>/module.ts) says about its addresses: its pages, its redirects and the
// paths the api process answers. Plain data, read by every process and by the web build; the site
// lists the modules it runs (site/modules/index.ts). The module's code plugs in through its own
// server.ts (backend/modules.ts) and web.tsx (apps/web/app/modules.ts).
import type { RedirectRule } from "./http-policy.ts";

export interface ModulePage {
  /** The address without its leading slash, as React Router writes it: "guides/:slug". */
  path: string;
  /** The route module, relative to the module's folder. */
  file: string;
  id?: string;
  /**
   * Not public yet: served at /preview/<path> to previewers (signed-in admins or people approved by a site module), 404 to everyone else (its loader uses
   * the web app's grayGet). Launching a page is deleting this, with what else skill launch-aihot-feature lists.
   */
  gray?: true;
  /**
   * Admin-only page at /admin/<path>, in the back office's own shell (its own sidebar, not the site's); its loader uses
   * adminPageGet and GRAY_HEADERS. Never inside a module's layout.
   */
  admin?: true;
  /** An admin page's name in the back office's sidebar. */
  nav?: string;
  /** Also served in English at /en/<path>: the page's reader-facing text is written in both languages (apps/web/app/lib/i18n.ts). */
  en?: true;
}

/** Pages that share a layout route. */
export interface ModuleLayout {
  layout: string;
  id?: string;
  pages: ModulePage[];
}

export interface ModuleDeclaration {
  /** Its folder under modules/. */
  name: string;
  /** Publish this module’s public pages and their redirects in both languages. */
  en?: true;
  /** Public pages, beside the engine's. */
  pages?: Array<ModulePage | ModuleLayout>;
  /** Matched after the engine's redirects, in this order. */
  redirects?: RedirectRule[];
  /** Paths the api process answers; the web server and the internal router send them there. */
  apiPaths?: RegExp[];
}

export function defineModule(module: ModuleDeclaration): ModuleDeclaration {
  for (const item of module.pages ?? []) for (const page of "layout" in item ? item.pages : [item]) {
    if (page.gray && page.admin) throw new Error("A page cannot be both gray and admin");
    if (page.admin && "layout" in item) throw new Error("An admin page sits in the back office's shell, not a module's layout");
    if (page.admin && !page.nav) throw new Error("An admin page needs its name in the back office's sidebar (nav)");
  }
  return module;
}
