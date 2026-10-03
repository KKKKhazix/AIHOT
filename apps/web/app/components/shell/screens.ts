// What a page tells the phone shell about itself, as its route `handle` (a Screen): the tab it sits under, the short
// name a back button shows when it leads there, and whether it brings its own bottom toolbar. Also the
// names of the pages in this tab's history, so a back button can say where it goes ("‹ 精选").
import { useMatches } from "react-router";
import { readJson, writeRaw } from "../../lib/local-state";
import type { TabKey } from "./nav";

export interface Screen {
  /** The tab this page sits under. Pages reached from several tabs leave it out and keep the tab the
   *  reader came from; `home` stands in when such a page is opened directly. */
  tab?: TabKey;
  home?: TabKey;
  /** Short name for back buttons that lead to this page (精选, 热点, 收藏 …). Pages named by their
   *  content leave it out; a back button to them reads "返回". */
  name?: string;
  /** The page draws its own bottom toolbar instead of the tab bar (articles). */
  toolbar?: boolean;
}

/** What the current page declares: route handles merged from the root down, the deepest route winning. */
export function useScreen(): Screen {
  let out: Screen = {};
  for (const m of useMatches()) if (m.handle && typeof m.handle === "object") out = { ...out, ...(m.handle as Screen) };
  return out;
}

/** Below the lg breakpoint (961px): the phone shell. */
export function isPhone(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 960px)").matches;
}

/** Position of this page in the tab's history (React Router keeps it in history.state). */
export function historyIndex(): number {
  if (typeof window === "undefined") return 0;
  const idx = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof idx === "number" && idx >= 0 ? idx : 0;
}

// Session storage, so a page the browser reloads still knows what lies behind it. Not a contract.
const SCREENS_KEY = "aihot:screens";
const MAX_SCREENS = 60;

interface HistoryScreen { key: string; name: string; tab?: TabKey }

function readScreens(): Record<string, HistoryScreen> {
  const parsed = readJson(SCREENS_KEY, "session");
  return parsed && typeof parsed === "object" ? (parsed as Record<string, HistoryScreen>) : {};
}

/** Records which page the current history entry shows ("" for one named by its content). */
export function noteScreen(name: string | undefined, key: string, tab: TabKey | undefined) {
  // POP changes browser history before its loader commits the next React location. An effect from
  // the page still on screen must not overwrite the destination entry during that interval.
  const browserKey = (window.history.state as { key?: string } | null)?.key ?? "default";
  if (browserKey !== key) return;
  const idx = historyIndex();
  const screens = readScreens();
  screens[idx] = { key, name: name ?? "", tab };
  // Entries far behind the current one are no longer reachable by a back button's label.
  for (const key of Object.keys(screens)) if (Number(key) < idx - MAX_SCREENS) delete screens[key];
  // Storage unavailable: back buttons fall back to their page's default label.
  writeRaw(SCREENS_KEY, JSON.stringify(screens), "session");
}

/** The name of the page a history back would show: undefined when unknown, "" when it has no short name. */
export function previousScreen(): string | undefined {
  const idx = historyIndex();
  if (idx === 0) return undefined;
  return readScreens()[idx - 1]?.name;
}

/** A shared page keeps its original tab on history back/forward and reload, not the last tab visited. */
export function rememberedTab(key: string): TabKey | undefined {
  for (const screen of Object.values(readScreens())) {
    if (screen?.key === key) return screen.tab;
  }
  return undefined;
}
