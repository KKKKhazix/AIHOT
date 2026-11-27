// Keep raw page samples in .private/operations/extract-samples/ (gitignored).
// Save once, run against the same samples in main and the changed worktree, then paste diff into the PR:
//   node scripts/eval-extract.ts save --urls urls.txt --out .private/operations/extract-samples/
//   node scripts/eval-extract.ts run --pages <samples> --out before.json
//   node scripts/eval-extract.ts run --pages <same samples> --out after.json
//   node scripts/eval-extract.ts diff before.json after.json
// URL lines may append a tab and PageRules JSON. No database, model calls or rendered-page fallback.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { load } from "cheerio";
import { stableJson } from "@aihot/contracts/sync";
import { readable, type PageRules } from "@aihot/backend/content/readable";
import { guardedFetch, languageHeaders } from "@aihot/backend/lib/http-fetch";
import { sha256 } from "@aihot/backend/lib/ids";
import { collapseWhitespace } from "@aihot/backend/lib/text";

interface SavedPage {
  id: string;
  url: string;
  rules: PageRules;
  fetchedAt: string;
  status: number | null;
  fetchedUrl?: string;
  contentType?: string;
  html?: string;
  error?: string;
}

interface Body {
  html: string;
  text: string;
  paragraphs: string[];
  images: string[];
  captions: Array<{ media: string[]; text: string }>;
  videos: Array<{ sources: string[]; poster: string | null }>;
  cover: NonNullable<ReturnType<typeof readable>>["cover"];
}

interface Result {
  id: string;
  url: string;
  rules: PageRules;
  body: Body | null;
  error?: string;
}

const normalize = collapseWhitespace;
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};

async function save(urls: string, out: string) {
  mkdirSync(out, { recursive: true });
  const pages: SavedPage[] = [];
  for (const line of readFileSync(urls, "utf8").split(/\r?\n/).filter(line => line.trim())) {
    const [address, settings] = line.split("\t");
    const url = new URL(address.trim()).href;
    const rules: PageRules = settings ? JSON.parse(settings) : {};
    const id = sha256(url + "\n" + stableJson(rules));
    if (pages.some(page => page.id === id)) continue;
    const page: SavedPage = { id, url, rules, fetchedAt: new Date().toISOString(), status: null };
    const target = new URL(url);
    if (rules.bodyUrlSuffix) target.pathname += rules.bodyUrlSuffix;
    // Only fetch failures are skipped; malformed input and filesystem errors must stop the command.
    const response = await guardedFetch(target.href, {
      headers: languageHeaders(rules.acceptLanguage), timeoutMs: 20_000, maxBytes: 16 * 1024 * 1024,
    }).catch((error: unknown) => { page.error = String(error); return null; });
    if (response) {
      page.status = response.status;
      page.fetchedUrl = response.url;
      page.contentType = response.headers.get("content-type") ?? "";
      if (response.status !== 200) page.error = `HTTP ${response.status}`;
      else if (!/html/i.test(page.contentType)) page.error = `Not HTML: ${page.contentType}`;
      else {
        page.html = `${id}.html`;
        // Decode exactly as the collector does; keep all original markup before extraction.
        writeFileSync(path.join(out, page.html), response.text());
      }
    }
    pages.push(page);
    writeJson(path.join(out, "pages.json"), pages);
    console.error(`${page.error ? `跳过：${page.error}` : "已保存"} ${url}`);
  }
  writeJson(path.join(out, "pages.json"), pages);
  console.log(`保存 ${pages.filter(page => page.html).length} 篇，跳过 ${pages.filter(page => page.error).length} 篇。`);
}

function run(pages: string, out: string) {
  const saved = readJson<SavedPage[]>(path.join(pages, "pages.json"));
  const results: Result[] = [];
  for (const page of saved) {
    if (!page.html) continue;
    // A page that makes extraction throw fails that article in production too: record it as this page's result.
    let extracted: ReturnType<typeof readable> = null, error: string | undefined;
    const html = readFileSync(path.join(pages, page.html), "utf8");
    try { extracted = readable(html, page.fetchedUrl!, page.rules); }
    catch (thrown) { error = String(thrown); }
    let body: Body | null = null;
    if (extracted) {
      const $ = load(extracted.html, null, false);
      const paragraphs = $("p,h2,h3,h4,h5,li,blockquote,pre,td,th,figcaption,caption,dt,dd")
        .filter((_, el) => !$(el).find("p,li,blockquote,pre,td,th,dt,dd").length)
        .toArray().map(el => normalize($(el).text())).filter(Boolean);
      body = {
        html: extracted.html, text: normalize(extracted.text), paragraphs,
        images: $("img[src]").toArray().map(el => $(el).attr("src")!),
        captions: $("figcaption,caption").toArray().map(el => ({
          media: $(el).closest("figure").find("img[src],video[src],source[src]").toArray().map(media => $(media).attr("src")!),
          text: normalize($(el).text()),
        })),
        videos: $("video").toArray().map(el => ({
          sources: [$(el).attr("src"), ...$(el).find("source[src]").toArray().map(source => $(source).attr("src"))].filter((src): src is string => !!src),
          poster: $(el).attr("poster") ?? null,
        })),
        cover: extracted.cover ?? null,
      };
    }
    results.push({ id: page.id, url: page.url, rules: page.rules, body, ...(error ? { error } : {}) });
  }
  writeJson(out, results);
  console.log(`回放 ${results.length} 篇，提取到正文 ${results.filter(result => result.body).length} 篇。`);
}

// Counts preserve repeated paragraphs and repeated media: losing one copy is still a change.
function added<T>(before: T[], after: T[]): T[] {
  const remaining = new Map<string, number>();
  for (const item of before) {
    const key = stableJson(item);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return after.filter(item => {
    const key = stableJson(item), count = remaining.get(key) ?? 0;
    if (count) { remaining.set(key, count - 1); return false; }
    return true;
  });
}

function diff(a: string, b: string) {
  const before = readJson<Result[]>(a), after = readJson<Result[]>(b);
  const old = new Map(before.map(page => [page.id, page]));
  const next = new Map(after.map(page => [page.id, page]));
  let unchanged = 0, layout = 0, words = 0, mediaOnly = 0, lostImages = 0, lostVideos = 0, unreadable = 0;
  const lines = ["正文提取回放比较", ""];
  const clip = (text: string) => normalize(text).slice(0, 120);
  const changes = <T>(label: string, first: T[], second: T[], display: (item: T) => string) => {
    for (const item of added(first, second)) lines.push(`  - 多了${label}：${display(item)}`);
    for (const item of added(second, first)) lines.push(`  - 少了${label}：${display(item)}`);
  };
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const first = old.get(id), second = next.get(id);
    if (!first || !second) {
      lines.push(`- ${second ? "新增样本" : "移除样本"}：${(second ?? first)!.url}`);
      continue;
    }
    const x = first.body, y = second.body;
    if (!x || !y) unreadable++;
    if (first.error !== second.error) lines.push(`- 抽取出错：${second.url}：${first.error ?? "无"} → ${second.error ?? "无"}`);
    if (stableJson(x) === stableJson(y)) { if (first.error === second.error) unchanged++; continue; }
    const textChanged = x?.text !== y?.text;
    const media = (body: Body | null) => body && [body.images, body.captions, body.videos, body.cover];
    const mediaChanged = stableJson(media(x)) !== stableJson(media(y));
    if (textChanged) words++;
    else if (mediaChanged) mediaOnly++;
    else layout++;
    const imageUrls = (body: Body | null) => [...(body?.images ?? []), ...(body?.cover ? [body.cover.url] : [])];
    const removedImages = added(imageUrls(y), imageUrls(x));
    const videoSources = (body: Body | null) => body?.videos.flatMap(video => video.sources) ?? [];
    const removedVideos = added(videoSources(y), videoSources(x));
    if (removedImages.length) lostImages++;
    if (removedVideos.length) lostVideos++;
    const xChars = [...(x?.text ?? "")].length, yChars = [...(y?.text ?? "")].length;
    lines.push(`- ${first.url}`, `  - ${textChanged ? "文字变化" : mediaChanged ? "仅媒体变化" : "只变版式"}；正文字数 ${xChars} → ${yChars}（${yChars - xChars >= 0 ? "+" : ""}${yChars - xChars}）`);
    if (!x || !y) lines.push(`  - 正文提取：${x ? "成功" : "未提取到"} → ${y ? "成功" : "未提取到"}`);
    changes("段落", x?.paragraphs ?? [], y?.paragraphs ?? [], clip);
    changes("图片", x?.images ?? [], y?.images ?? [], url => url);
    changes("视频", videoSources(x), videoSources(y), url => url);
    if (stableJson(x?.captions) !== stableJson(y?.captions)) changes("图注", x?.captions ?? [], y?.captions ?? [], caption => `${clip(caption.text)}${caption.media.length ? `（${caption.media.join(", ")}）` : ""}`);
    if (stableJson(x?.videos) !== stableJson(y?.videos) && !removedVideos.length && !added(videoSources(x), videoSources(y)).length) lines.push("  - 视频顺序或海报变化");
    if (stableJson(x?.cover) !== stableJson(y?.cover)) lines.push(`  - 封面：${stableJson(x?.cover ?? null)} → ${stableJson(y?.cover ?? null)}`);
  }
  lines.push("", `汇总：没变 ${unchanged} 篇；只变版式 ${layout} 篇；字变了 ${words} 篇；仅媒体变化 ${mediaOnly} 篇；少了图片 ${lostImages} 篇；少了视频 ${lostVideos} 篇。`,
    `样本：新增 ${after.filter(page => !old.has(page.id)).length} 篇；移除 ${before.filter(page => !next.has(page.id)).length} 篇；任一次未提取到正文 ${unreadable} 篇。`);
  console.log(lines.join("\n"));
}

const [command, ...args] = process.argv.slice(2);
if (command === "diff") {
  if (args.length !== 2) throw new Error("Usage: diff <a.json> <b.json>");
  diff(args[0], args[1]);
} else if (command === "save" || command === "run") {
  const input = command === "save" ? "urls" : "pages";
  const { values } = parseArgs({ args, options: { [input]: { type: "string" }, out: { type: "string" } } });
  if (!values[input] || !values.out) throw new Error(`Usage: ${command} --${input} <${input}> --out <output>`);
  if (command === "save") await save(values[input] as string, values.out as string);
  else run(values[input] as string, values.out as string);
} else throw new Error("Usage: eval-extract.ts <save|run|diff> ...");
