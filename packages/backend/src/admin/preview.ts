import { ADMIN } from "@aihot/site";
import { actorOf, devPrincipal, sessionPrincipal } from "./auth.ts";
import { serverModules, type Previewer } from "../modules.ts";

/** Gray pages admit engine admins and the site's module-provided previewers. */
export async function previewPrincipal(cookieHeader: string | undefined): Promise<Previewer | null> {
  // A site without admin pages has no admin sign-in, so a leftover admin session never stands in for the preview list.
  const admin = ADMIN ? await sessionPrincipal(cookieHeader) : devPrincipal();
  if (admin) return { name: admin.name, actor: actorOf(admin) };
  const preview = serverModules().find((module) => module.preview)?.preview;
  return preview ? preview(cookieHeader) : null;
}
