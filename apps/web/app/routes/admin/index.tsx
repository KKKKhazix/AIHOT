import { redirect } from "react-router";

/** The admin opens on the first of these; the sources are the first thing a new site sets up and the list to watch. */
const LANDING = [
  "/admin/sources",
];

export function loader() {
  throw redirect(LANDING[0]!);
}

export default function AdminIndex() {
  return null;
}
