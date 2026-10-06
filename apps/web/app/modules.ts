// What a module's web.tsx (modules/<name>/web.tsx) may add to the engine's pages: navigation entries, admin
// entries and the parts of a few pages that leave room for them. Its own pages come from its module.ts
// (routes.ts). The site's list is read through site-modules.ts.
//
// Every page loads web.tsx. A part only one page draws is given as its loader (`Part`), so it ships with that
// page's code: the page waits for its parts while its own code loads (site-modules.ts `loadParts`) and then
// renders them like any import.
import type { ComponentType, ReactNode } from "react";
import type { TopicSummary } from "@aihot/contracts/site";
import type { NavItem, Tab } from "./components/shell/nav";

export interface AdminNavEntry {
  to: string;
  label: string;
  /** The badge: a key of the admin's navigation counts (its server module's admin.counts). */
  count?: string;
  tone?: "bad" | "accent";
}

export type Part<T> = () => Promise<{ default: T }>;

/** What each panel of the agent page, and each module's part drawn on it, is given (routes/agent.tsx). */
export interface AgentPanelProps {
  /** The site's public address, read on the server so the page and the browser agree. */
  base: string;
  /** The value of the tag on what visitors copy (AgentPart.tag) as it is now; null on a site without one. */
  tag: string | null;
  /** The page's time (ms), read on the server like `base`: what depends on it reads the same in the browser. */
  now: number;
}

/** A way in on the agent page: a card in its chooser and a tab (`?tab=<key>`) with its panel. */
export interface AgentTrack {
  key: string;
  /** On its card and in the aside's list. */
  name: string;
  /** Where the page and the 我的 page list the ways in a few words. */
  short: string;
  badge?: string;
  pitch: string;
  /** What it suits, under the pitch. */
  fit: string;
  icon: ComponentType<{ size?: number }>;
  Panel: ComponentType<AgentPanelProps>;
  /** Ids of sections in its panel: the page's address with one as its fragment opens this tab and scrolls there. */
  anchors?: string[];
}

/**
 * A tag on everything the agent page's visitors copy, so their use of each way in can be told apart: copied
 * addresses carry it as a query parameter, the curl commands in their User-Agent, and panels get its value.
 */
export interface CopyTag {
  /** A hook giving its value: the same on the server and in the first render, this browser's once the page runs. */
  useValue: () => string;
  /** The query parameter of copied addresses. */
  query: string;
  /** Its product in the copied curl commands' User-Agent. */
  userAgent: (value: string) => string;
  /** What it is: under the chooser, under the MCP address and under the feeds. */
  Note: ComponentType;
  mcp: string;
  rss: string;
}

/** Links from a module's part of the agent page into a panel's section. */
export interface AgentLinks {
  /** The page's address that opens the panel holding the section `anchor` and scrolls there. */
  href: (anchor: string) => string;
  /** Does the same without leaving the page. */
  open: (anchor: string) => void;
}

/** A module's part of the agent page (routes/agent.tsx, features/agent/panels.tsx). */
export interface AgentPart {
  /** Ways in of its own, ahead of the engine's MCP, RSS and API. */
  tracks?: AgentTrack[];
  /** The tag on what visitors copy; the first module's is used. */
  tag?: CopyTag;
  /** Between the page's header and the chooser. */
  Banner?: ComponentType<AgentPanelProps & AgentLinks>;
  /** Sections at the end of a track's panel (`track` is its key); `anchor`, the section's id, opens it like the track's own. */
  blocks?: Array<{ track: string; anchor: string; Block: ComponentType<AgentPanelProps> }>;
  /** Its clients built on the Agent guide, by name: named next to the guide in the resources and in the API panel's table. */
  guideClients?: string[];
  /** The aside's resources, after the engine's: [label, address, what it is for]. */
  resources?: Array<[label: string, href: string, note: string]>;
  /** The MCP panel's tool table: its tools. */
  tools?: Array<{ name: string; does: string; ask: string }>;
  /** The MCP panel's 连不上怎么办: entries after the engine's first. */
  mcpTroubles?: ReactNode[];
  /** What the RSS panel's opening sentence goes on to say, a clause each after "；". */
  rssLead?: string[];
  /** The API panel's table: a group of its addresses. */
  api?: { group: string; rows: Array<[path: string, does: string, often: string]> };
  /** The API panel's usage tabs: one each, after the engine's. */
  recipes?: Array<{ key: string; label: string; Body: ComponentType<{ base: string; curl: string }> }>;
  /** The API panel's 出错了怎么办: [status, what to do], after the engine's. */
  apiErrors?: Array<[status: string, what: ReactNode]>;
}

/** A module's part of a topic page (routes/topic.tsx), from what its server module's topics.page returned for it. */
export interface TopicPagePart {
  /** What it is called: after "最新动态与" in the page's title, and in the name of its structured-data list. */
  name: string;
  /** Whether it has anything on this page; without, the page leaves it out of its body and its head. */
  shows: (data: unknown, topic: TopicSummary) => boolean;
  /** Drawn between the page's header and its list. */
  Block: ComponentType<{ data: unknown; topic: TopicSummary }>;
  /** Its entries for the page's structured data, newest first; one with an event page links to it. */
  entries: (data: unknown) => Array<{ title: string; href: string | null }>;
  /** The headlines of its most important recent events: the search snippet leads with the first two. */
  news: (data: unknown) => string[];
}

export interface WebModule {
  /** Its folder under modules/. */
  name: string;
  /** Desktop sidebar: entries in a section between the engine's 内容 and 更多; modules naming the same section share it. */
  sidebar?: { section: string; items: NavItem[] };
  /** Phone tab bar: tabs before 我的. */
  tabs?: Tab[];
  /** The 我的 page: rows ahead of the engine's tools. */
  tools?: Array<{ to: string; label: string; icon: ReactNode }>;
  admin?: {
    /** Navigation groups of its own, ahead of the engine's. */
    groups?: Array<{ group: string; items: AdminNavEntry[] }>;
    /** Entries in the 内容 group, after the engine's 信源. */
    content?: AdminNavEntry[];
    /** Its part of the runs page, drawn from what its server module's admin.runs returns. */
    runs?: Part<ComponentType<{ data: unknown }>>;
    /** The page the admin opens on instead of the sources (routes/admin/index.tsx); the first module's wins. */
    landing?: string;
    /** Where the model prices are kept: the models page links its 未定价 there (routes/admin/models.tsx). */
    prices?: string;
  };
  /** Parts of every public page (root.tsx); the admin has its own chrome and gets none of them. */
  root?: {
    /** An inline script in <head>, after the theme's: it runs before the page paints. */
    bootScript?: string;
    /** Above the page's content. */
    Top?: ComponentType;
    /** After the page. */
    Bottom?: ComponentType;
    /** Headers the document's own request to the api carries (the root loader). */
    documentHeaders?: (request: Request) => Record<string, string>;
  };
  agent?: Part<AgentPart>;
  topicPage?: Part<TopicPagePart>;
  /** Paths of the marks it serves that are drawn in white, for a dark tile (components/BrandMark.tsx). */
  darkMarks?: string[];
  /** The starred page (routes/starred.tsx): buttons ahead of 导入文件 that bring stars in from elsewhere, each resolving to the line it reports. */
  starredImports?: Array<{ label: string; run: () => Promise<{ ok: boolean; text: string }> }>;
  /**
   * The feedback page (routes/feedback.tsx): a draft kept elsewhere in this browser, read when the page
   * keeps none of its own ({ content, email, pageUrl }), and cleared once its own is saved or sent.
   */
  feedbackDraft?: { read: () => unknown; clear: () => void };
  /** The terms page's footer: links after the engine's (routes/terms.tsx). */
  termsLinks?: Array<{ to: string; label: string }>;
  /** Its ways into the agent page (AgentPart.tracks) by their short names: the 我的 page's row names the first three (routes/more.tsx). */
  agentWays?: string[];
}

export function defineWebModule(module: WebModule): WebModule {
  return module;
}
