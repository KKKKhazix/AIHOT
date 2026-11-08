import { Link } from "react-router";
import type { MentionRun } from "@aihot/contracts/mentions";

/**
 * A text of the page with its links drawn as links in a sentence: names to their pages (linkMentions), web
 * addresses, shown short, to themselves in a new tab (addresses.ts).
 */
export function MentionText({ runs }: { runs: MentionRun[] }) {
  return (
    <>
      {runs.map((run, i) =>
        typeof run === "string" ? (
          run
        ) : /^https?:\/\//.test(run.href) ? (
          <a key={i} href={run.href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent hover:underline">
            {run.text}
          </a>
        ) : (
          <Link key={i} viewTransition to={run.href} className="text-accent hover:underline">
            {run.text}
          </Link>
        ),
      )}
    </>
  );
}
