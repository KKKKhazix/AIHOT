import { redirect } from "react-router";
import { webModules } from "../../site-modules";

/** The admin opens on a module's page when one offers it, else on the sources: the first thing a new site sets up and the list to watch. */
export function loader() {
  throw redirect(webModules().find((m) => m.admin?.landing)?.admin?.landing ?? "/admin/sources");
}

export default function AdminIndex() {
  return null;
}
