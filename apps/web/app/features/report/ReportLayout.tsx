import { useState, type ReactNode } from "react";
import type { ReportKind } from "@aihot/contracts/site";
import { BarButton, PhoneBar, type BackTarget } from "../../components/shell/PhoneBar";
import { OutlineSheet, type OutlineEntry } from "../../components/ui/OutlineSheet";
import { IconList } from "../../components/icons";
import { KindSwitch, ReportArchive, ReportPhoneNav } from "./ReportNav";
import type { ArchiveGroup } from "./format";
import { useT } from "../../lib/i18n";

/**
 * Report pages sit beside their own archive column (desktop from `side`), flush against the site sidebar.
 * Phones get a bar with the kind switch and the issue's outline (本期目录), the recent issues under it;
 * narrower desktops get the same above the paper; a page below the reports (the archive) gets a bar
 * leading back instead. The paper is centred beside the archive, on a faintly toned paper in the light
 * theme, up to 1160px.
 */
export function ReportLayout({ kind, groups, current, today, outline = [], back, title, children }: {
  kind: ReportKind;
  groups: ArchiveGroup[];
  current: string | null;
  today: string;
  /** The issue's pages (reportOutline). */
  outline?: OutlineEntry[];
  /** Below the reports: where the phone bar leads back, and the page's name. */
  back?: BackTarget;
  title?: string;
  children: ReactNode;
}) {
  const t = useT();
  const [outlineOpen, setOutlineOpen] = useState(false);
  return (
    <div className="report-shell lg:-mx-5 lg:-mb-[72px] lg:-mt-6 lg:flex lg:min-h-dvh wide:-mx-7">
      <ReportArchive kind={kind} groups={groups} current={current} />
      <div className="min-w-0 flex-1 pb-6 lg:flex lg:flex-col lg:items-center lg:px-10 lg:pb-16 lg:pt-9">
        {back ? (
          <PhoneBar back={back} title={title} />
        ) : (
          <>
            <PhoneBar
              center={<KindSwitch kind={kind} phone />}
              actions={
                outline.length > 0 && (
                  <BarButton label={t("本期目录", "In this issue")} onClick={() => setOutlineOpen(true)}>
                    <IconList size={21} />
                  </BarButton>
                )
              }
            />
            <div className="hidden w-full max-w-[1160px] items-center justify-between gap-4 lg:flex side:hidden">
              <KindSwitch kind={kind} phone layoutId="report-kind-narrow" />
              {outline.length > 0 && (
                <button type="button" onClick={() => setOutlineOpen(true)} className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-ui-label font-medium text-ink-3 transition-colors hover:bg-bg-sunk hover:text-ink">
                  <IconList size={16} />{t(" 本期目录", " In this issue")}
                </button>
              )}
            </div>
            <ReportPhoneNav kind={kind} groups={groups} current={current} today={today} />
            {outline.length > 0 && <OutlineSheet title={t("本期目录", "In this issue")} open={outlineOpen} onClose={() => setOutlineOpen(false)} outline={outline} />}
          </>
        )}
        <div className="w-full lg:max-w-[1160px]">{children}</div>
      </div>
    </div>
  );
}
