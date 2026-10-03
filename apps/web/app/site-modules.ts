// The site's modules on the web (site/modules/web.ts). Shared engine files read them where they draw them,
// not when they are imported, so a module's code may import any engine file.
import { WEB_MODULES } from "@aihot/site/modules/web";
import type { Part, WebModule } from "./modules";

export function webModules(): readonly WebModule[] {
  return WEB_MODULES;
}

/** The parts a page draws, in the site's order: awaited at the top of the page's module, so they load with it. */
export async function loadParts<T>(pick: (m: WebModule) => Part<T> | undefined): Promise<Array<{ name: string; part: T }>> {
  return Promise.all(WEB_MODULES.flatMap((m) => {
    const load = pick(m);
    return load ? [load().then((loaded) => ({ name: m.name, part: loaded.default }))] : [];
  }));
}
