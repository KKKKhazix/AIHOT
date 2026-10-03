// Inline stroke icons (no icon-font or network requests).
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const IconBolt = (p: P) => (<Svg {...p}><path d="M13 2.5L4.5 13.5H11l-1 8L19.5 10.5H13z" /></Svg>);
export const IconHeart = (p: P) => (<Svg {...p}><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0112 7.3a4.3 4.3 0 017.5 2.5C19.5 15.4 12 20 12 20z" /></Svg>);
export const IconUsers = (p: P) => (<Svg {...p}><path d="M16 20v-1.5a3.5 3.5 0 00-3.5-3.5h-5A3.5 3.5 0 004 18.5V20" /><circle cx="10" cy="8" r="3.5" /><path d="M20 20v-1.5a3.5 3.5 0 00-2.5-3.35M15.5 4.65a3.5 3.5 0 010 6.7" /></Svg>);
export const IconDoc = (p: P) => (<Svg {...p}><rect x="5" y="3.5" width="14" height="17" rx="2" /><path d="M8.5 8h7M8.5 12h7M8.5 16h4" /></Svg>);
export const IconList = (p: P) => (<Svg {...p}><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" /></Svg>);
export const IconFlame = (p: P) => (<Svg {...p}><path d="M12 22c4 0 7-2.7 7-7 0-3.6-2.4-6.2-4-8-.5 2-1.6 3.4-3 4 .3-3-1-6-4-8 0 4-4 6.5-4 11 0 4.3 3 8 8 8z" /></Svg>);
export const IconGrid = (p: P) => (<Svg {...p}><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></Svg>);
export const IconBookmark = (p: P & { filled?: boolean }) => { const { filled, ...rest } = p; return (<Svg {...rest}><path d="M6 3.5h12v17l-6-4-6 4z" fill={filled ? "currentColor" : "none"} /></Svg>); };
export const IconChart = (p: P) => (<Svg {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>);
export const IconClock = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>);
export const IconPlug = (p: P) => (<Svg {...p}><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 01-10 0zM12 16v5" /></Svg>);
export const IconSparkles = (p: P) => (<Svg {...p}><path d="M11 3.5l1.7 4.8 4.8 1.7-4.8 1.7L11 16.5l-1.7-4.8L4.5 10l4.8-1.7z" /><path d="M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></Svg>);
export const IconRss = (p: P) => (<Svg {...p}><path d="M5 11a8 8 0 018 8M5 4.5A14.5 14.5 0 0119.5 19" /><circle cx="6" cy="18" r="1.3" /></Svg>);
export const IconCode = (p: P) => (<Svg {...p}><path d="M8 7.5L3.5 12 8 16.5M16 7.5l4.5 4.5-4.5 4.5M13.5 5l-3 14" /></Svg>);
export const IconInfo = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></Svg>);
export const IconHistory = (p: P) => (<Svg {...p}><path d="M3.5 12a8.5 8.5 0 102.5-6" /><path d="M3.5 4v4h4" /><path d="M12 8v4l2.5 2" /></Svg>);
export const IconMessage = (p: P) => (<Svg {...p}><path d="M4 5h16v11H9l-5 4z" /></Svg>);
export const IconSearch = (p: P) => (<Svg {...p}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></Svg>);
export const IconSun = (p: P) => (<Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" /></Svg>);
export const IconMoon = (p: P) => (<Svg {...p}><path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" /></Svg>);
export const IconMonitor = (p: P) => (<Svg {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Svg>);
export const IconArrowLeft = (p: P) => (<Svg {...p}><path d="M19 12H5M11 18l-6-6 6-6" /></Svg>);
export const IconArrowRight = (p: P) => (<Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>);
export const IconArrowUpRight = (p: P) => (<Svg {...p}><path d="M7 17L17 7M8 7h9v9" /></Svg>);
export const IconChevronDown = (p: P) => (<Svg {...p}><path d="M6 9l6 6 6-6" /></Svg>);
export const IconChevronRight = (p: P) => (<Svg {...p}><path d="M9 6l6 6-6 6" /></Svg>);
export const IconChevronLeft = (p: P) => (<Svg {...p}><path d="M15 5l-7 7 7 7" /></Svg>);
export const IconExternal = (p: P) => (<Svg {...p}><path d="M14 4h6v6M20 4l-9 9" /><path d="M19 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1h5" /></Svg>);
export const IconDownload = (p: P) => (<Svg {...p}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></Svg>);
export const IconImage = (p: P) => (<Svg {...p}><rect x="3.5" y="3.5" width="17" height="17" rx="2.5" /><circle cx="9" cy="9" r="1.6" /><path d="M20.5 15.5l-4.5-4.5-9 9.5" /></Svg>);
export const IconShare = (p: P) => (<Svg {...p}><circle cx="18" cy="5.5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="18.5" r="2.5" /><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1" /></Svg>);
export const IconMenu = (p: P) => (<Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>);
/** Three dots in a row: more actions (phone bars). */
export const IconMore = ({ size = 18, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
    <circle cx="5.5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="18.5" cy="12" r="1.6" />
  </svg>
);
export const IconFilter = (p: P) => (<Svg {...p}><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></Svg>);
export const IconUser = (p: P) => (<Svg {...p}><circle cx="12" cy="8" r="3.8" /><path d="M4.8 20.2c.9-3.5 3.8-5.7 7.2-5.7s6.3 2.2 7.2 5.7" /></Svg>);
export const IconClose = (p: P) => (<Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>);
export const IconArrowUp = (p: P) => (<Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>);
export const IconTrendUp = (p: P) => (<Svg {...p}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></Svg>);
export const IconTrendDown = (p: P) => (<Svg {...p}><path d="M3 7l6 6 4-4 8 8" /><path d="M15 17h6v-6" /></Svg>);
export const IconMinus = (p: P) => (<Svg {...p}><path d="M5 12h14" /></Svg>);
export const IconCheck = (p: P) => (<Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>);
export const IconCopy = (p: P) => (<Svg {...p}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" /></Svg>);
