import { Link } from "react-router";
import type { MentionRun } from "@aihot/contracts/mentions";

/** A text of the page with the names it links to their pages (linkMentions), as links in a sentence are drawn. */
export function MentionText({ runs }: { runs: MentionRun[] }) {
  return (
    <>
      {runs.map((run, i) =>
        typeof run === "string" ? (
          run
        ) : (
          <Link key={i} viewTransition to={run.href} className="text-accent hover:underline">
            {run.text}
          </Link>
        ),
      )}
    </>
  );
}
