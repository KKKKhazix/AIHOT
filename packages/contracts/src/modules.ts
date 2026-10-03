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
  /** Public pages, beside the engine's. */
  pages?: Array<ModulePage | ModuleLayout>;
  /** Admin pages, inside the admin's layout (and behind its sign-in). */
  adminPages?: ModulePage[];
  /** Matched after the engine's redirects, in this order. */
  redirects?: RedirectRule[];
  /** Paths the api process answers; the web server and the internal router send them there. */
  apiPaths?: RegExp[];
}

export function defineModule(module: ModuleDeclaration): ModuleDeclaration {
  return module;
}
