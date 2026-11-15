import { actorOf, sessionPrincipal } from "./auth.ts";
import { serverModules, type Previewer } from "../modules.ts";

/** Gray pages admit engine admins and the site's module-provided previewers. */
export async function previewPrincipal(cookieHeader: string | undefined): Promise<Previewer | null> {
  const admin = await sessionPrincipal(cookieHeader);
  if (admin) return { name: admin.name, actor: actorOf(admin) };
  const preview = serverModules().find((module) => module.preview)?.preview;
  return preview ? preview(cookieHeader) : null;
}
