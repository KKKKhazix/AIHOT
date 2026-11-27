// "← 返回…" above a page on desktop: goes back through the reader's history when a page of ours is behind it,
// or to `to` with `label` when opened directly (kept as a real link for new-tab clicks and crawlers).
import { useLayoutEffect, useState } from "react";
import { useLocation } from "react-router";
import { IconArrowLeft } from "../icons";
import { historyIndex, previousScreen, useHistoryBack } from "./screens";
import { Link } from "../../lib/link";
import { useT, type Text } from "../../lib/i18n";

export function BackLink({
  to,
  label,
  showPrevious = true,
  iconSize = 14,
  className = "hidden items-center gap-1.5 py-2 text-ui-label text-ink-3 transition-colors hover:text-accent touch:min-h-11 lg:inline-flex",
}: {
  to: string;
  label: Text;
  /** When true (default), names the previous screen from history ("返回模型榜"); when false, uses plain "返回" / "Back". */
  showPrevious?: boolean;
  iconSize?: number;
  className?: string;
}) {
  const { onClick } = useHistoryBack();
  const { key } = useLocation();
  const t = useT();
  const fixed = t(label);
  const [text, setText] = useState(fixed);
  useLayoutEffect(() => {
    if (historyIndex() === 0) return setText(fixed);
    if (!showPrevious) return setText(t("返回", "Back"));
    const behind = previousScreen();
    setText(behind ? t(`返回${t(behind)}`, `Back to ${t(behind)}`) : t("返回", "Back"));
  }, [key, fixed, showPrevious, t]);
  return (
    <Link to={to} onClick={onClick} className={className}>
      <IconArrowLeft size={iconSize} /> {text}
    </Link>
  );
}
