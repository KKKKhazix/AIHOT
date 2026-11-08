import { SITE } from "@aihot/site";
import badge from "./police-badge.png";

/** The filing numbers mainland-China sites must show at the bottom of the page, each linked to its registry:
 *  the public-security number first, then the ICP number. */
export function Filings({ className, badgeSize }: { className: string; badgeSize: number }) {
  return (
    <>
      {SITE.psb && (
        // The registry's own markup: the badge before the number, linked to the record.
        <a
          href={`https://beian.mps.gov.cn/#/query/webSearch?code=${SITE.psb.replace(/\D/g, "")}`}
          target="_blank"
          rel="noreferrer"
          className={`inline-flex items-center gap-1 [text-autospace:no-autospace] ${className}`}
        >
          <img src={badge} alt="" width={badgeSize} height={Math.round((badgeSize * 40) / 36)} className="shrink-0" />
          {SITE.psb}
        </a>
      )}
      {SITE.icp && (
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer" className={`[text-autospace:no-autospace] ${className}`}>
          {SITE.icp}
        </a>
      )}
    </>
  );
}
