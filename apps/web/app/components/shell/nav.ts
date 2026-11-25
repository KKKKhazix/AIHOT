// Site navigation in one place: the desktop sidebar's sections and the phone tab bar's tabs, the engine's
// and the site's modules'. An English page leads only to pages that have an English edition.
import type { ReactNode } from "react";
import { NAV, SITE, subjectAfter, withSubject } from "@aihot/site";
import { webModules } from "../../site-modules";
import { L, hasEnglish, type Locale, type Phrase, type Text } from "../../lib/i18n";
import {
  IconBolt, IconBookmark, IconDoc, IconFlame, IconGrid, IconHeart, IconList, IconMessage, IconPlug, IconSparkles, IconUser,
} from "../icons";

export interface NavItem {
  to: string;
  label: Text;
  icon: (p: { size?: number }) => ReactNode;
  /** Match the path exactly (the home page). */
  end?: boolean;
  /** Other pages the entry stands for: they and the pages under them light it too. */
  covers?: string[];
  /** Shows the unread dot while the changelog has news. */
  changelog?: boolean;
}

const SECTIONS: Array<{ key: string; title: Text; items: NavItem[] }> = [
  {
    key: "content",
    title: L("内容", "News"),
    items: [
      { to: "/", label: L("精选", "Top Picks"), icon: IconBolt, end: true },
      { to: "/all", label: L(subjectAfter("全部", "动态"), `All ${SITE.subject} News`), icon: IconList },
      { to: "/hot", label: L("热点榜", "Trending"), icon: IconFlame },
      { to: "/daily", label: L(withSubject("日报"), `${SITE.subject} Daily`), icon: IconDoc, covers: ["/weekly", "/monthly"] },
      { to: "/topics", label: L("主题", "Topics"), icon: IconGrid },
      { to: "/starred", label: L("收藏", "Saved"), icon: IconBookmark },
    ],
  },
  {
    key: "more",
    title: L("更多", "More"),
    items: [
      { to: "/agent", label: L("Agent 接入", "For Agents"), icon: IconPlug },
      { to: "/about", label: L("关于", "About"), icon: IconHeart },
      { to: "/changelog", label: L("更新日志", "Changelog"), icon: IconSparkles, changelog: true },
      { to: "/feedback", label: L("反馈", "Feedback"), icon: IconMessage },
    ],
  },
];

/** Whether an engine page is a way in from the navigation (site.ts NAV.hidden); a hidden page still opens. */
const inNav = (to: string) => !(NAV.hidden as readonly string[]).includes(to);
export const topicsInNav = inNav("/topics");
export const hotInNav = inNav("/hot");

/** A section's title as the site writes it: what modules name a shared section by. */
const chinese = (text: Text) => (typeof text === "string" ? text : text.zh);

/** Whether the navigation of a page in this language leads to `to`: an English page only to English editions. */
const inLanguage = (to: string, locale: Locale) => locale === "zh" || hasEnglish(to);

const UP = {
  "/hot": { name: L("热点榜", "Trending"), back: L("热点", "Trending"), tab: "hot" },
  "/topics": { name: L("主题", "Topics"), back: L("全部主题", "All topics"), tab: "me" },
} as const;

/**
 * Where pages under a navigation entry lead back up to: the entry, or 精选 in its place while the site hides
 * it. `name` is for breadcrumbs and desktop back links (热点榜), `back` for the phone bar (热点), `tab` the
 * phone tab it sits under, `crumbs` its breadcrumb after the site's home.
 */
export function navUp(entry: keyof typeof UP): { to: string; name: Phrase; back: Phrase; tab: TabKey; crumbs: Array<{ name: Phrase; path: string }> } {
  if (!inNav(entry)) return { to: "/", name: L("精选", "Top Picks"), back: L("精选", "Top Picks"), tab: "featured", crumbs: [] };
  return { to: entry, ...UP[entry], crumbs: [{ name: UP[entry].name, path: entry }] };
}

/**
 * The sidebar: the engine's sections with the modules' between 内容 and 更多; a module naming a section
 * that is already there adds to it. A section takes its title from the first module with an entry in it here.
 */
export function sidebar(locale: Locale): Array<{ key: string; title: Text; items: NavItem[] }> {
  const shown = (items: readonly NavItem[]) => items.filter((i) => inNav(i.to) && inLanguage(i.to, locale));
  const [content, ...rest] = SECTIONS;
  const more = rest.pop()!;
  const sections = [content!, ...rest].map((s) => ({ ...s, items: shown(s.items) }));
  for (const m of webModules()) {
    if (!m.sidebar) continue;
    const items = shown(m.sidebar.items);
    if (!items.length) continue;
    const title = chinese(m.sidebar.section);
    const sectionKey = m.sidebar.sectionKey ?? title;
    const section = sections.find((s) => s.key === sectionKey || chinese(s.title) === title);
    if (section) section.items.push(...items);
    else sections.push({ key: sectionKey, title: m.sidebar.section, items });
  }
  return [...sections, { ...more, items: shown(more.items) }];
}

/** A sidebar entry is lit on its pages and the ones it covers (日报 also covers weekly and monthly reports). */
export function sidebarIsActive(item: Pick<NavItem, "to" | "end" | "covers">, pathname: string): boolean {
  if (item.end) return pathname === item.to;
  return [item.to, ...(item.covers ?? [])].some((to) => pathname === to || pathname.startsWith(`${to}/`));
}

/**
 * The deepest entry a path belongs to: a page can sit under more than one entry of its section (a module's
 * list and a detail page under it), and only the most specific one is lit.
 */
export function activeSidebarItem(items: readonly NavItem[], pathname: string): NavItem | null {
  let lit: NavItem | null = null;
  for (const item of items) {
    if (sidebarIsActive(item, pathname) && (!lit || item.to.length > lit.to.length)) lit = item;
  }
  return lit;
}

/**
 * The phone tab bar: 全部 lives beside 精选 as a switch, 热点 and 日报 are tabs, and "我的" at /more holds
 * 收藏, 外观, the tools and the site's own pages. Which tab a page sits under is declared by the page
 * itself (components/shell/screens.ts).
 */
export type TabKey =
  | "featured"
  | "hot"
  | "daily"
  | "me"
  // A module's tab.
  | (string & {});

export interface Tab {
  key: TabKey;
  to: string;
  label: Text;
  icon: (p: { size?: number }) => ReactNode;
  /** As NavItem.covers. */
  covers?: string[];
  changelog?: boolean;
}

const ENGINE_TABS: Tab[] = [
  { key: "featured", to: "/", label: L("精选", "Top Picks"), icon: IconBolt },
  { key: "hot", to: "/hot", label: L("热点", "Trending"), icon: IconFlame },
  { key: "daily", to: "/daily", label: L("日报", "Daily"), icon: IconDoc, covers: ["/weekly", "/monthly"] },
  { key: "me", to: "/more", label: L("我的", "Me"), icon: IconUser, changelog: true },
];

/** The tab bar: the engine's, the modules' before 我的. */
export function tabs(locale: Locale): Tab[] {
  const modules = webModules().flatMap((m) => m.tabs ?? []).filter((t) => inLanguage(t.to, locale));
  return [...ENGINE_TABS.slice(0, -1).filter((t) => inNav(t.to)), ...modules, ENGINE_TABS.at(-1)!];
}

/**
 * The rail that stands in for the sidebar on narrow desktops (unfolded foldables, tablets upright): the
 * tabs, with 全部 after 精选 since desktop pages have no 精选 | 全部 switch.
 */
export function rail(locale: Locale): Tab[] {
  const all = tabs(locale);
  if (!inNav("/all")) return all;
  const at = all.findIndex((t) => t.key === "featured") + 1;
  return [...all.slice(0, at), { key: "all", to: "/all", label: L("全部", "All"), icon: IconList }, ...all.slice(at)];
}

/** A rail entry is lit on its pages; 我的 also on the pages that sit under it on phones. */
export function railIsActive(tab: Tab, pathname: string, screenTab: TabKey | undefined): boolean {
  if (tab.key === "me") return pathname === tab.to || screenTab === "me";
  return sidebarIsActive({ to: tab.to, end: tab.to === "/", covers: tab.covers }, pathname);
}
