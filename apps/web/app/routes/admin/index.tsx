import { redirect } from "react-router";

/** The admin opens on the sources: the first thing a new site sets up and the list to watch. */
export function loader() {
  throw redirect("/admin/sources");
}

export default function AdminIndex() {
  return null;
}
