// Tibo post collection for the reset monitor (SocialData, paid). Posts and their reply/quote
// context are stored before the cursor moves; recognition runs afterwards in publication order.
// Incremental ten-minute scans overlap by fifteen minutes to include late-indexed replies.
import { sql } from "../db.ts";
import type { CodexResetContextPost } from "@aihot/contracts/monitor";
import { SITE } from "@aihot/industry/site";
import { shutdownSignal } from "../jobs/queue.ts";
import { getTweet, searchTweets, tweetText, type SdTweet } from "../providers/socialdata.ts";
import { ProviderRejectedError } from "../providers/receipts.ts";
import { deliverContent } from "../notify/deliver.ts";
import { applyRecognition } from "./assemble.ts";
import { recognizePost, type ContextInput, type OpenEventInput } from "./recognize.ts";
import { awaitingReviewCondition, bjIso, codexResetsSnapshot, MONITOR_PAGE_URL } from "./read.ts";

export const AUTHOR = "thsottiaux";
const OVERLAP_MS = 15 * 60_000;
const MAX_PAGES = 5;
const PUSH_MAX_AGE_MS = 36 * 3600_000;

async function getState<T>(key: string): Promise<T | null> {
  const [row] = await sql<{ value: T }[]>`SELECT value FROM monitor_state WHERE key = ${key}`;
  return row?.value ?? null;
}

async function setState(key: string, value: unknown) {
  await sql`INSERT INTO monitor_state (key, value) VALUES (${key}, ${sql.json(value as never)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

async function touchWatermarks(patch: Record<string, string>) {
  await sql`INSERT INTO monitor_state (key, value) VALUES ('watermarks', ${sql.json(patch)})
    ON CONFLICT (key) DO UPDATE SET value = monitor_state.value || EXCLUDED.value, updated_at = now()`;
}

const idGreater = (a: string, b: string) => (a.length !== b.length ? a.length > b.length : a > b);

async function contextOf(t: SdTweet, subject: string): Promise<Array<ContextInput & { url: string }>> {
  const out: Array<ContextInput & { url: string }> = [];
  const push = (x: SdTweet, relation: "reply" | "quote") =>
    out.push({ id: x.id_str, author: x.user.screen_name, relation, text: tweetText(x), publishedAt: new Date(x.tweet_created_at).toISOString(), url: `https://x.com/i/status/${x.id_str}` });
  if (t.quoted_status) push(t.quoted_status, "quote");
  let parentId = t.in_reply_to_status_id_str ?? null;
  for (let depth = 0; parentId && depth < 2; depth++) {
    const [stored] = await sql<{ tweet: SdTweet | null }[]>`SELECT raw->'tweet' AS tweet FROM monitor_posts WHERE id = ${parentId}`;
    const parent = stored?.tweet ?? await getTweet(parentId, { purpose: "monitor.context", subject });
    if (!parent) break;
    push(parent, "reply");
    if (parent.quoted_status && depth === 0) push(parent.quoted_status, "quote");
    parentId = parent.in_reply_to_status_id_str ?? null;
  }
  return out;
}

async function storePost(t: SdTweet) {
  const context = await contextOf(t, `x:${t.id_str}`);
  await sql`
    INSERT INTO monitor_posts (id, author, published_at, text, url, context, raw, origin)
    VALUES (${t.id_str}, ${t.user.screen_name}, ${new Date(t.tweet_created_at)}, ${tweetText(t)}, ${`https://x.com/${AUTHOR}/status/${t.id_str}`},
            ${sql.json(context.map(({ publishedAt: _p, ...c }) => ({ id: c.id, author: c.author, relation: c.relation, text: null, originalText: c.text, url: c.url })) as never)},
            ${sql.json({ tweet: t, context } as never)}, 'live')
    ON CONFLICT (id) DO NOTHING`;
}

/**
 * The collection cursor: the newest post read, and the stretches a long gap left unread. A scan reads
 * at most five pages from the newest post down; when there is more, the rest of that stretch (down to
 * the post the previous scan stopped at) is kept with its page cursor and read by later ticks, so a
 * stop longer than five pages never skips posts.
 */
interface Cursor {
  sinceId: string | null;
  /** Start of the last successful live scan; lookback never advances live coverage. */
  scannedThrough?: string;
  backlog?: Array<{ next: string | null; stopAt: string | null; query?: string; beforeId?: string | null }>;
}

/** Collects new posts (or a lookback window) and stores them before moving the cursor. */
export async function collectPosts(opts: { lookbackHours?: number } = {}): Promise<{ stored: number; pages: number }> {
  const started = new Date();
  await touchWatermarks({ lastAttemptAt: started.toISOString() });
  const cursor = (await getState<Cursor>("cursor")) ?? { sinceId: null };
  let covered = cursor.scannedThrough ? Date.parse(cursor.scannedThrough) : null;
  if (covered === null && cursor.sinceId && !opts.lookbackHours) {
    // A cursor written before time-based scans holds only the newest id (sites deployed earlier still
    // have one): start from that post's time, without cutting off a long outage or the overlap behind it.
    const [last] = await sql<{ published_at: Date }[]>`SELECT published_at FROM monitor_posts WHERE id = ${cursor.sinceId}`;
    covered = last?.published_at.getTime() ?? null;
  }
  const since = opts.lookbackHours ? Math.floor((started.getTime() - opts.lookbackHours * 3600_000) / 1000)
    : covered !== null ? Math.floor((covered - OVERLAP_MS) / 1000) : null;
  const query = since !== null ? `from:${AUTHOR} since_time:${since}` : `from:${AUTHOR}`;
  const window = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const found: SdTweet[] = [];
  let pages = 0;

  /** Pages from `from` until a post at or below `stopAt`, the end, or the page budget. */
  const read = async (query: string, from: string | null, stopAt: string | null, budget: number) => {
    let next = from;
    let beforeId: string | null = null;
    let used = 0;
    do {
      const res = await searchTweets(query, { purpose: opts.lookbackHours ? "monitor.lookback" : "monitor.scan", subject: `x:${AUTHOR}`, window, cursor: next });
      used++;
      let reachedKnown = false;
      for (const t of res.tweets) {
        if (!beforeId || idGreater(beforeId, t.id_str)) beforeId = t.id_str;
        if (t.retweeted_status) continue; // native reposts are not his words
        if (stopAt && !idGreater(t.id_str, stopAt)) {
          reachedKnown = true;
          continue;
        }
        found.push(t);
      }
      const repeated = next !== null && next === res.nextCursor;
      next = reachedKnown ? null : res.nextCursor;
      if (repeated) break;
    } while (next && used < budget);
    pages += used;
    return { next, beforeId };
  };

  const backlog = [...(cursor.backlog ?? [])];
  const stopAt = since !== null ? null : cursor.sinceId;
  const more = await read(query, null, stopAt, MAX_PAGES);
  // Initial scans and lookbacks also have unread tails. Keep the exact query for their cursors.
  if (more.next) backlog.push({ ...more, stopAt, query });
  // Older stretches next, oldest first, within one more scan's worth of pages.
  let budget = MAX_PAGES;
  for (const gap of backlog) {
    if (budget <= 0) break;
    const before = pages;
    try {
      const left = await read(gap.query ?? `from:${AUTHOR}`, gap.next, gap.stopAt, budget);
      gap.next = left.next ?? "";
      gap.beforeId = left.beforeId ?? gap.beforeId;
    } catch (error) {
      console.error(JSON.stringify({ level: "error", msg: "monitor backlog page failed", error: String(error).slice(0, 300) }));
      // A rejected or old cursor is still a coverage gap, never evidence of a complete scan.
      if (error instanceof ProviderRejectedError && (error.status === 400 || error.status === 422)) {
        // SocialData supports max_id: resume below the last stored page when its opaque cursor expires.
        if (gap.beforeId) gap.query = `${(gap.query ?? `from:${AUTHOR}`).replace(/ max_id:\d+/g, "")} max_id:${BigInt(gap.beforeId) - 1n}`;
        gap.next = null;
      }
      break;
    }
    budget -= Math.max(1, pages - before);
  }

  let stored = 0;
  const unique = [...new Map(found.map((t) => [t.id_str, t])).values()];
  const existing = new Set((await sql<{ id: string }[]>`SELECT id FROM monitor_posts WHERE id = ANY(${unique.map((t) => t.id_str)}::text[])`).map((p) => p.id));
  for (const t of unique.sort((a, b) => (idGreater(a.id_str, b.id_str) ? 1 : -1))) {
    if (existing.has(t.id_str)) continue;
    await storePost(t);
    stored++;
  }
  const newest = found.reduce<string | null>((m, t) => (!m || idGreater(t.id_str, m) ? t.id_str : m), cursor.sinceId);
  const next: Cursor = {
    ...cursor,
    ...(!opts.lookbackHours ? { sinceId: newest, scannedThrough: started.toISOString() } : {}),
    backlog: backlog.filter((g) => g.next !== ""),
  };
  if (!next.backlog?.length) delete next.backlog;
  if (JSON.stringify(next) !== JSON.stringify(cursor)) await setState("cursor", next);
  await touchWatermarks({ lastCollectedAt: started.toISOString() });
  return { stored, pages };
}

async function openEvents(before: Date): Promise<OpenEventInput[]> {
  const rows = await sql<{ id: string; type: OpenEventInput["kind"]; status: OpenEventInput["status"]; schedule: { label: string } | null; first_at: Date; excerpt: string }[]>`
    SELECT e.id, e.type, e.status, e.schedule, min(p.published_at) AS first_at,
      (SELECT ep.original_text FROM monitor_event_posts ep JOIN monitor_posts pp ON pp.id = ep.post_id WHERE ep.event_id = e.id ORDER BY pp.published_at LIMIT 1) AS excerpt
    FROM monitor_events e JOIN monitor_event_posts l ON l.event_id = e.id JOIN monitor_posts p ON p.id = l.post_id
    WHERE NOT e.withdrawn AND e.created_at <= ${before}
      AND ((e.status = 'announced' OR e.confirmation_basis = 'receipt_review' AND e.confirmed_at IS NULL) AND e.created_at >= ${new Date(before.getTime() - 72 * 3600_000)}
           OR e.confirmed_at >= ${new Date(before.getTime() - 48 * 3600_000)})
    GROUP BY e.id ORDER BY first_at DESC LIMIT 8`;
  return rows.map((r) => ({ id: r.id, kind: r.type, status: r.status, firstPostAt: r.first_at.toISOString(), excerpt: r.excerpt, schedule: r.schedule?.label ?? null }));
}

type NotifyAction = "announce" | "confirm" | "amend" | "withdraw";

const KIND_NAME = (type: string) => (type === "reset_credit" ? "重置卡发放" : "Codex 额度重置");
const HEADLINE: Record<NotifyAction, (kind: string) => string> = {
  announce: (k) => `${k}：Tibo 已宣布`,
  confirm: (k) => `${k}已完成（Tibo 确认）`,
  amend: (k) => `${k}：安排有更新`,
  withdraw: (k) => `${k}：Tibo 撤回了预告`,
};
const bjStamp = (iso: string) => `${iso.slice(5, 16).replace("T", " ")}`;
interface PushPost {
  post_id: string;
  published_at: Date;
  text: string;
  originalText: string;
  context: CodexResetContextPost[];
  notify: Array<{ eventId: string; action: NotifyAction }>;
}

/**
 * One card per post, however many resets it speaks of: the conclusion first, each reset's expected time
 * (or confirmation time, or withdrawal), the audience, the outage it follows, the question a short reply
 * answers, Tibo's words in Chinese and the links.
 */
function resetPostCard(post: PushPost, entries: Array<{ eventId: string; action: NotifyAction }>, snapshot: Awaited<ReturnType<typeof codexResetsSnapshot>>, withdrawn: Map<string, { type: string }>) {
  type Event = (typeof snapshot.events)[number];
  const described = entries.flatMap((n): Array<{ eventId: string; action: NotifyAction; type: string; e: Event | null }> => {
    const e = snapshot.events.find((x) => x.id === n.eventId);
    if (e) return [{ ...n, type: e.type, e }];
    const w = withdrawn.get(n.eventId);
    return n.action === "withdraw" && w ? [{ ...n, type: w.type, e: null }] : [];
  });
  if (!described.length) return null;
  const primary = described[0]!;
  const lines: string[] = [];
  for (const [i, d] of described.entries()) {
    if (i > 0) lines.push(`**${HEADLINE[d.action](KIND_NAME(d.type))}**`);
    const window = d.e?.estimate ?? d.e?.schedule;
    if ((d.action === "announce" || d.action === "amend") && window) lines.push(`**预计生效**：${window.label}${d.e?.estimate ? `（${SITE.name} 推算）` : ""}`);
    if (d.action === "confirm" && d.e?.confirmedAt) lines.push(`**确认时间**：北京时间 ${bjStamp(d.e.confirmedAt)}（确认帖时间，不是精确到账时间）`);
    if (d.action === "withdraw") lines.push("此前宣布的这次安排已撤回，以 Codex 内显示为准。");
  }
  const scoped = described.find((d) => d.e)?.e;
  if (scoped) lines.push(`**适用范围**：${scoped.presentation?.audienceZh ?? scoped.presentation?.scopeLabel ?? "未说明"}${scoped.presentation?.productsZh ? ` · ${scoped.presentation.productsZh}` : ""}`);
  const outage = snapshot.outage && described.some((d) => d.eventId === snapshot.outage!.resetEventId) ? snapshot.outage : null;
  if (outage?.publishedAt) lines.push(`**起因**：${bjStamp(outage.publishedAt)} Tibo 确认 Codex 故障${outage.recoveredAt ? `，${bjStamp(outage.recoveredAt).slice(6)} 恢复` : ""}`);
  const words = post.text;
  // A short reply needs the question it answers.
  const parent = post.originalText.length <= 120 ? post.context.find((c) => (c.text ?? c.originalText).replace(/[^\p{L}\p{N}]/gu, "").length >= 8) : undefined;
  const title = HEADLINE[primary.action](KIND_NAME(primary.type));
  const tone = primary.action === "confirm" ? "turquoise" : primary.action === "withdraw" ? "grey" : "orange";
  return {
    header: { title: { tag: "plain_text", content: title }, template: tone },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
      parent ? { tag: "div", text: { tag: "lark_md", content: `${parent.relation === "quote" ? "引用" : "回复"} @${parent.author}：${(parent.text ?? parent.originalText).slice(0, 160)}` } } : null,
      words ? { tag: "div", text: { tag: "lark_md", content: `> ${words.replace(/\n/g, "\n> ")}` } } : null,
      {
        tag: "action",
        actions: [
          { tag: "button", text: { tag: "plain_text", content: "查看原帖" }, url: `https://x.com/${AUTHOR}/status/${post.post_id}`, type: "default" },
          { tag: "button", text: { tag: "plain_text", content: "打开重置监控" }, url: MONITOR_PAGE_URL, type: "primary" },
        ],
      },
    ].filter(Boolean),
  };
}

/**
 * Recognizes stored posts that have not been processed, oldest first. A failure stops the run (later
 * posts may relate to this one); the post is retried next tick, and ops.alerts reports a post stuck
 * for long, which an admin can then skip.
 */
export async function processPending(limit = 20): Promise<{ processed: number; failed: number }> {
  const posts = await sql<{ id: string; text: string; published_at: Date; raw: { context?: Array<ContextInput & { url: string }> } | null }[]>`
    SELECT id, text, published_at, raw FROM monitor_posts WHERE processed_at IS NULL AND author = ${AUTHOR}
    ORDER BY published_at, id LIMIT ${limit}`;
  let processed = 0;
  let failed = 0;
  for (const p of posts) {
    if (shutdownSignal.signal.aborted) break; // later posts wait for the next tick, in order
    try {
      const rec = await recognizePost({ id: p.id, text: p.text, publishedAt: p.published_at.toISOString(), context: p.raw?.context ?? [], openEvents: await openEvents(p.published_at) });
      await applyRecognition(p.id, rec);
      processed++;
      await sql`DELETE FROM monitor_state WHERE key = ${`failures:${p.id}`}`;
    } catch (error) {
      failed++;
      const prev = (await getState<{ count: number; since: string }>(`failures:${p.id}`)) ?? { count: 0, since: new Date().toISOString() };
      await setState(`failures:${p.id}`, { count: prev.count + 1, since: prev.since, error: String(error).slice(0, 300) });
      console.error(JSON.stringify({ level: "error", msg: "monitor recognition failed", post: p.id, error: String(error).slice(0, 300) }));
      break; // keep order: later posts wait for this one
    }
  }
  return { processed, failed };
}

/**
 * Sends the pushes processed posts owe (stored with their recognition), oldest first: after a normal
 * recognition, and after a stop between recognizing a post and delivering its push. One card per post
 * and group slot (the key of its first push, as earlier cards were keyed), so nothing is sent twice;
 * a change or withdrawal is told only where the announcement itself went out; pushes older than 36
 * hours are dropped.
 */
export async function flushResetPushes(): Promise<number> {
  const posts = await sql<PushPost[]>`
    SELECT p.id AS post_id, p.published_at, p.recognition->'notify' AS notify,
      coalesce(p.translation, p.text) AS text, p.text AS "originalText", p.context
    FROM monitor_posts p
    WHERE p.processed_at IS NOT NULL AND p.author = ${AUTHOR} AND p.published_at > ${new Date(Date.now() - PUSH_MAX_AGE_MS)}
      AND jsonb_array_length(coalesce(p.recognition->'notify', '[]'::jsonb)) > 0
    ORDER BY p.published_at, p.id`;
  if (!posts.length) return 0;
  let snapshot: Awaited<ReturnType<typeof codexResetsSnapshot>> | null = null;
  let pushed = 0;
  const targets = await sql<{ key: string; enabled_at: Date | null }[]>`SELECT key, enabled_at FROM notify_targets WHERE purpose = 'content' AND enabled`;
  for (const p of posts) {
    for (const target of targets) {
      if (target.enabled_at && p.published_at < target.enabled_at) continue;
      const entries: Array<{ eventId: string; action: NotifyAction }> = [];
      for (const n of p.notify) {
        if (n.action === "amend" || n.action === "withdraw") {
          // A post can announce several events in one card, whose subject is only the first event.
          // Its saved recognition preserves the others. Corrections in that post do not establish
          // delivery: they may have been omitted for a group that never received the announcement.
          const [told] = await sql`
            SELECT 1 FROM deliveries d LEFT JOIN monitor_posts original ON original.id = split_part(d.dedupe_key, ':', 2)
            WHERE d.subject_kind = 'codex_reset' AND d.target_key = ${target.key}
              AND d.status IN ('sent', 'unknown', 'sending') AND d.dedupe_key NOT LIKE ${`codex:${p.post_id}:%`}
              AND (d.subject_id = ${n.eventId} OR EXISTS (
                SELECT 1 FROM jsonb_array_elements(coalesce(original.recognition->'notify', '[]'::jsonb)) entry
                WHERE entry->>'eventId' = ${n.eventId} AND entry->>'action' IN ('announce', 'confirm')
              )) LIMIT 1`;
          if (!told) continue;
        }
        entries.push(n);
      }
      if (!entries.length) continue;
      const dedupeKey = `codex:${p.post_id}:${entries[0]!.eventId}:${entries[0]!.action}`;
      const [delivered] = await sql`SELECT 1 FROM deliveries WHERE target_key = ${target.key} AND dedupe_key = ${dedupeKey}`;
      if (delivered) continue;
      snapshot ??= await codexResetsSnapshot();
      const gone = entries.filter((e) => e.action === "withdraw").map((e) => e.eventId);
      const withdrawn = new Map(gone.length ? (await sql<{ id: string; type: string }[]>`SELECT id, type FROM monitor_events WHERE id IN ${sql(gone)}`).map((r) => [r.id, r]) : []);
      const card = resetPostCard(p, entries, snapshot, withdrawn);
      if (!card) continue;
      const results = await deliverContent({ subjectKind: "codex_reset", subjectId: entries[0]!.eventId, dedupeKey, contentAt: p.published_at, card, targetKey: target.key });
      pushed += results.filter((r) => r.status === "sent").length;
    }
  }
  return pushed;
}

/** One scheduled run: collect (or look back), process what was stored, push what is owed, then move the verified watermark. */
export async function monitorTick(opts: { lookbackHours?: number } = {}) {
  // The ten-minute scan and the daily lookback are separate schedules that both run at 04:40; one waits
  // for the other, so their cursor updates cannot interleave. A session lock, because model and network
  // calls hold no database transaction; process exit releases it, so a stale lock cannot stop monitoring.
  const connection = await sql.reserve();
  try {
    await connection`SELECT pg_advisory_lock(hashtext('monitor.tick'))`;
    try { return await tick(opts); }
    finally { await connection`SELECT pg_advisory_unlock(hashtext('monitor.tick'))`; }
  } finally { connection.release(); }
}

async function tick(opts: { lookbackHours?: number }) {
  const started = new Date();
  // A failed collection still lets the posts already stored be read and told; the failure is raised
  // after that, and the round is not counted as verified.
  let collected: Awaited<ReturnType<typeof collectPosts>> | null = null;
  let collectError: unknown = null;
  try {
    collected = await collectPosts({ lookbackHours: opts.lookbackHours });
  } catch (err) {
    collectError = err;
  }
  const backlog = (await getState<Cursor>("cursor"))?.backlog?.length ?? 0;
  // Do not interpret new posts ahead of the older, unread pages they may refer to.
  const result = backlog ? { processed: 0, failed: 0 } : await processPending();
  const pushed = await flushResetPushes();
  if (collectError) throw collectError;
  const [pending] = await sql<{ n: number; review: number }[]>`
    SELECT count(*) FILTER (WHERE processed_at IS NULL)::int AS n, count(*) FILTER (WHERE ${awaitingReviewCondition()})::int AS review
    FROM monitor_posts WHERE author = ${AUTHOR}`;
  // Verified in full only with nothing waiting: no post unprocessed or waiting for review, no stretch of
  // posts still unread behind a long gap.
  const complete = !pending?.n && !pending?.review && !backlog;
  if (complete) await touchWatermarks({ lastVerifiedAt: started.toISOString() });
  return { ...collected, ...result, pushed, pending: pending?.n ?? 0, verifiedAt: complete ? bjIso(started) : null };
}
