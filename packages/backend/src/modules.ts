// The backend's sockets for modules (modules/<name>/server.ts). The api and worker processes install the
// site's list when they start (site/modules/server.ts); the engine reads the sockets when it needs them and
// never imports a module, so it runs the same with none installed: the open-source edition, and the
// engine's own tests. Each socket names the engine file that reads it.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WorkOptions } from "pg-boss";
import type { z } from "zod";
import type { Brand } from "@aihot/contracts/site";
import type { Db } from "./db.ts";
import type { QueueOptions } from "./jobs/queue.ts";
import type { Finding } from "./notify/feishu.ts";
import type { Topic, TopicMember } from "./publication/topics.ts";

/** A cron schedule (Asia/Shanghai), recorded in job_runs like the engine's (apps/worker/src/schedules.ts). */
export interface Scheduled {
  name: string;
  cron: string;
  run: () => Promise<unknown>;
  missed?: "skip" | "once";
  /** Read when the worker starts: false removes the schedule and its execution queue; run history remains. */
  when?: () => boolean;
}

/** A model step (editorial/models.ts); its default model comes from site/models.ts, else `default`. */
export interface ModelStep {
  label: string;
  env: string;
  /** Receipt purposes it produces (for the admin statistics). */
  purposes: string[];
  vision?: boolean;
}

/**
 * Something Agents can ask: an address under /api/v1/agent (routes/agent.ts) and an MCP tool with the
 * same answer (routes/mcp.ts), named in the guide (publication/agent.ts) and in llms.txt.
 */
export interface AgentAbility {
  /** Address under /api/v1/agent: "/status". */
  path: string;
  /** Named in the guide's first sentence, after the engine's abilities: "服务状态". */
  title: string;
  /** The guide's table row: what the user wants to know. */
  ask: string;
  /** The Markdown answer. */
  answer: () => Promise<string>;
  etagPrefix: string;
  cacheControl: string;
  mcp: {
    /** The tool name after the site's prefix: "get_status". */
    tool: string;
    /** What the server's instructions say it is for: "for service status". */
    use: string;
    description: string;
    input: z.ZodObject;
    /** The text (the same answer) and the structured content. */
    run: (args: Record<string, unknown>) => Promise<{ text: string; structured: Record<string, unknown> }>;
  };
}

/** Lines of /llms.txt (publication/llms.ts), each placed in its section. */
export interface LlmsLines {
  /** The public API list, after the engine's news endpoints. */
  api?: string[];
  /** Polling rhythm, a clause each, before the RSS one ("X 每 10 分钟读一次 …；"). */
  pace?: string[];
  /** The site's main pages, after the topics. */
  pages?: string[];
  /** What the topics section's opening sentence goes on to say about the topic pages, a clause each after "；". */
  topics?: string[];
  /** Sentences after the access section's opening one. */
  access?: string[];
  /** The usage notes, after the engine's. */
  usage?: string[];
  /** Its clients built on the Agent guide, by name: the guide's line says Agents without them read it, and that they read it too. */
  guideClients?: string[];
  /** Ways in of its own beside MCP, RSS and the API, a line each after the guide's. */
  ways?: string[];
}

/**
 * A job queue of its own, beside the engine's (jobs/queue.ts): created with its options on first use, worked
 * by the worker (workModuleQueues), and filled with `enqueueOn`, which types the data by the queue.
 */
export interface ModuleQueue<T = never> {
  /** "<module>.<what>". */
  name: string;
  /** Policy, retries and expiry (pg-boss createQueue). */
  options: QueueOptions;
  /** How the worker takes its jobs (pg-boss work). */
  worker: WorkOptions;
  run: (data: T) => Promise<unknown>;
}

export function defineQueue<T>(queue: ModuleQueue<T>): ModuleQueue<T> {
  return queue;
}

export interface SitemapEntry {
  loc: string;
  lastmod?: Date | null;
  changefreq?: string;
  priority?: number;
}

/**
 * What happened in the engine, for modules that act on it (`emit` below). A handler runs in the process
 * that made the change and, given one, inside its transaction.
 */
export interface EngineHooks {
  /**
   * An article's public content changed; a former event is included when its membership moved.
   */
  articleChanged: (change: { id: string; kind: "detail" | "body" | "content"; reason: string; previousStoryIds?: number[] }, tx: Db) => Promise<void>;
  /** A source's articles were published again after changing its public metadata or permissions. */
  sourceRepublished: (change: { sourceId: string }) => Promise<void>;
  /** A report was published, or what one shows changed. */
  reportsChanged: (change: { reason: string }, tx: Db) => Promise<void>;
  /** The api answered a request. Never awaited and must not throw. */
  requestAnswered: (req: FastifyRequest, reply: FastifyReply, path: string) => void;
  /**
   * A public exit took a client's request: "rss" (routes/feeds.ts, a feed is sent), "mcp" (routes/mcp.ts,
   * past its host and origin checks) or a module's own. Never awaited and must not throw.
   */
  exitServed: (exit: string, req: FastifyRequest) => void;
}

/** What a topic page asks a module's part of it (publication/topics.ts loadTopicPage). */
export interface TopicPageAsk {
  topic: Topic;
  page: number;
  /** The topic's members, newest first, as the topic index read them (it is kept a minute). */
  members: readonly TopicMember[];
  /** What its `index` computed with that index. */
  index: unknown;
  /** The page's time. */
  now: Date;
}

/** A reminder in a JSON answer, as its top-level `notice`. */
export interface JsonNotice {
  notice: object;
  /** It depends on what shared caches do not tell apart (the User-Agent): the answer is then kept in none. */
  private?: boolean;
}

/** A reminder over MCP: after the server's instructions, after every tool's text and as `notice` in its structured content. */
export interface McpNotice {
  instructions: string;
  text: string;
  notice: object;
}

/** A reminder in a feed: an item ahead of the feed's own. `description` is HTML. */
export interface FeedNotice {
  guid: string;
  title: string;
  link: string;
  description: string;
  at: Date;
}

/**
 * A reminder for the person behind a request, which their Agent or reader passes on (it is not content),
 * asked at each exit; the first module with one gives it (requestNotice).
 */
export interface RequestNotices {
  /** v1 JSON (routes/v1.ts). */
  json: (req: FastifyRequest) => JsonNotice | null;
  /** The Agent's Markdown answers (routes/agent.ts): Markdown after the answer. */
  agent: (req: FastifyRequest) => string | null;
  /** MCP (routes/mcp.ts). Each distinct reminder gets a server of its own. */
  mcp: (req: FastifyRequest) => McpNotice | null;
  /** RSS (routes/feeds.ts), for the feed at `feedPath`. */
  feed: (req: FastifyRequest, feedPath: string) => FeedNotice | null;
}

export interface ServerModule {
  /** Its folder under modules/. */
  name: string;
  /** Its HTTP routes, registered before the engine's v1 fallbacks (apps/api/src/app.ts). */
  http?: (app: FastifyInstance) => void;
  /** Run before the api process exits, to flush what it buffers (apps/api/src/main.ts). */
  stop?: () => Promise<void>;
  agent?: {
    abilities?: AgentAbility[];
    /** The guide's "目前查不到的" list, after the engine's first entry. */
    unavailable?: string[];
    /** The guide's "请求" list (how to ask), after the engine's first entry. */
    requests?: string[];
  };
  llms?: () => Promise<LlmsLines> | LlmsLines;
  sitemap?: {
    /** After the engine's content pages (the topics), before the site's own (agent, about, terms). */
    pages?: SitemapEntry[];
    /** After the stories. */
    entries?: () => Promise<SitemapEntry[]>;
  };
  admin?: {
    /** Badges on the admin navigation, by the key its web items name (admin/navigation.ts). */
    counts?: Record<string, () => Promise<number>>;
    /** Its part of the admin's runs page, under its name (admin/runs.ts); its web module draws it. */
    runs?: () => Promise<unknown>;
  };
  models?: Record<string, ModelStep>;
  /** Cron schedules (the worker). */
  schedules?: Scheduled[];
  /** What is wrong now, for the owner's alerts (operations/alerts.ts), after the engine's problems. */
  alerts?: (now: number) => Promise<Finding[]>;
  /** What the content groups receive from it, as the alerts name it: "状态". */
  pushes?: string[];
  /** Its share of the daily retention run (operations/retention.ts): what it deleted or aggregated. */
  retention?: (now: Date) => Promise<Record<string, unknown>>;
  on?: Partial<EngineHooks>;
  /** Topic pages (publication/topics.ts). */
  topics?: {
    /**
     * Its part of a topic page, under its name in TopicPage.modules; its web module draws it. The page names
     * reports only as they are now, so withdrawals and corrections apply although the index is a minute old.
     */
    page?: {
      /** Computed from every member of the topic index when the index is read, and kept with it. */
      index?: (members: readonly TopicMember[], now: Date) => Promise<unknown>;
      /**
       * The members it may name, read again with the page, and its part from them as they are now: one no
       * longer selected is missing, `topics` is its current membership. Null when it has no part on the page.
       * Work the part out inside `part`, from `current`: what `read` works out from `ask.members` is up to a
       * minute old, so a withdrawn or corrected report would stay on the page until the index is read again.
       */
      read: (ask: TopicPageAsk) => { recheck: string[]; part: (current: ReadonlyMap<string, TopicMember>) => unknown } | null;
    };
    /** Company marks by topic slug, drawn over the engine's monograms. */
    marks?: () => Promise<Record<string, Brand>>;
  };
  /**
   * Source kinds it collects in its own way (admin/sources.ts), by kind: `resumed` runs in the transaction
   * that enables a paused source of that kind, before its row is written; `fetchNow` takes over the admin's
   * manual fetch, and what it returns is recorded in the audit trail.
   */
  sourceKinds?: Record<string, {
    resumed?: (sourceId: string, tx: Db) => Promise<void>;
    fetchNow?: (source: { id: string; config: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  }>;
  /** Lines of the Monday source-health report (operations/reports.ts), after the source counts. */
  sourceHealth?: (now: number) => Promise<string[]>;
  /** Job queues of its own (jobs/queue.ts). */
  queues?: ModuleQueue[];
  /** Follow-ups for the daily digest (level digest), after the engine's (operations/alerts.ts). */
  followUps?: (now: number) => Promise<Finding[]>;
  /** Further hosts the site answers on, over https: MCP accepts them as Host and as a browser's Origin (routes/mcp.ts). */
  hosts?: string[];
  /** Reminders for the person behind a request, by exit (RequestNotices). */
  notices?: Partial<RequestNotices>;
  /** The origin v1 links stories at while it returns one, instead of the site's (publication/links.ts: hot topics' links.story, related stories' links.api). */
  storyOrigin?: () => string | null;
  /** More keys a feedback sender is known by; a ban under any of them holds (operations/feedback.ts). */
  feedbackKeys?: (ip: string) => string[];
}

export function defineServerModule(module: ServerModule): ServerModule {
  return module;
}

let installed: readonly ServerModule[] = [];

/** Called once by each process's entry point, and by a module's tests for that module. */
export function installModules(modules: readonly ServerModule[]): void {
  installed = modules;
}

export function serverModules(): readonly ServerModule[] {
  return installed;
}

/** The first installed module's reminder for the person behind this request, at this exit. */
export function requestNotice<K extends keyof RequestNotices>(exit: K, ...args: Parameters<RequestNotices[K]>): ReturnType<RequestNotices[K]> | null {
  for (const m of installed) {
    const ask = m.notices?.[exit] as ((...a: Parameters<RequestNotices[K]>) => ReturnType<RequestNotices[K]>) | undefined;
    const notice = ask?.(...args);
    if (notice) return notice;
  }
  return null;
}

/** Tells every installed module that handles it, one after another. */
export async function emit<K extends Exclude<keyof EngineHooks, "requestAnswered" | "exitServed">>(hook: K, ...args: Parameters<EngineHooks[K]>): Promise<void> {
  for (const m of installed) {
    const handler = m.on?.[hook] as ((...a: Parameters<EngineHooks[K]>) => Promise<void>) | undefined;
    if (handler) await handler(...args);
  }
}
