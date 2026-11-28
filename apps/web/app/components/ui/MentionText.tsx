import { Fragment } from "react";
import type { MentionRun } from "@aihot/contracts/mentions";
import { Link } from "../../lib/link";

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
            {run.text.split(/(?=[./?#&][\p{L}\p{N}])/u).map((part, index) => (
              <Fragment key={index}>
                {index > 0 && <wbr />}
                {part}
              </Fragment>
            ))}
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
