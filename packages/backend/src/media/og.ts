// 1200×630 share images. satori lays out text with Noto Sans SC (assets/og-fonts) and emits glyphs
// as paths, so rasterising with sharp needs no system fonts. Output is cached on disk by content.
import { readdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import satori from "satori";
import sharp from "sharp";
import { config, REPO_ROOT } from "../config.ts";
import { needsEnglish } from "@aihot/contracts/english";
import { SITE } from "@aihot/site";

export const OG_TEMPLATE_VERSION = "og-2026-09-29.1";
/**
 * How English cards and posters are set (englishText here and in poster.ts): changed with them, so English images
 * already drawn and cached are drawn again. Only English keys carry it; Chinese ones stay as they were.
 */
export const ENGLISH_LAYOUT_VERSION = "en-2026-11-25.1";
const WIDTH = 1200;
const HEIGHT = 630;
const CACHE_DIR = path.join(config.dataDir, "ogcache");

export interface OgCard {
  kicker: string;
  title: string;
  subtitle?: string | null;
  meta?: string | null;
  /** Small emphasised figure on the right (e.g. an item score). */
  badge?: { value: string; label: string } | null;
  accent?: "teal" | "hot" | "amber";
  /** Set only on an English card, which is set as English (englishText). A Chinese card leaves it out, so its key stays as it was. */
  lang?: "en";
}

let fontsPromise: Promise<Array<{ name: string; data: Buffer; weight: 400 | 700; style: "normal" }>> | null = null;

const FONT_DIR = path.join(REPO_ROOT, "assets/og-fonts");

/**
 * Fonts a site adds beside Noto Sans SC for the characters its subset lacks (traditional and Japanese
 * kanji, kana, Hangul, accented Latin): `<name>-400.ttf` and `<name>-700.ttf` in assets/og-fonts. satori
 * takes a glyph the first font has no outline for from the next one, so they come after Noto Sans SC.
 */
export function fallbackFontFiles(files: string[]): string[] {
  return files.filter((f) => /^.+-(400|700)\.ttf$/.test(f) && !f.startsWith("noto-sans-sc-")).sort();
}

/** None by default: the share images and their cache keys are then what they were without this. */
export const FALLBACK_FONTS = fallbackFontFiles(readdirSync(FONT_DIR));

function fonts() {
  fontsPromise ??= Promise.all([
    readFile(path.join(FONT_DIR, "noto-sans-sc-400.ttf")),
    readFile(path.join(FONT_DIR, "noto-sans-sc-700.ttf")),
    ...FALLBACK_FONTS.map((f) => readFile(path.join(FONT_DIR, f))),
  ]).then(([regular, bold, ...more]) => [
    { name: "Noto Sans SC", data: regular!, weight: 400, style: "normal" },
    { name: "Noto Sans SC", data: bold!, weight: 700, style: "normal" },
    ...more.map((data, i) => ({ name: FALLBACK_FONTS[i]!.replace(/-(400|700)\.ttf$/, ""), data, weight: (FALLBACK_FONTS[i]!.endsWith("-700.ttf") ? 700 : 400) as 400 | 700, style: "normal" as const })),
  ]);
  return fontsPromise;
}

export type Node = { type: string; props: Record<string, unknown> & { style?: Record<string, unknown>; children?: unknown } };
export const h = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): Node => ({ type, props: { style, children, ...extra } });

/** The site's host as shown on cards. */
export const SITE_HOST = new URL(config.siteUrl).host;

/** Width over height of an SVG: its viewBox, else its width and height. */
function aspect(svg: string): number {
  const box = /<svg[^>]*\sviewBox="([^"]+)"/.exec(svg)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (box?.length === 4 && box[2]! > 0 && box[3]! > 0) return box[2]! / box[3]!;
  const width = Number.parseFloat(/<svg[^>]*\swidth="([^"]+)"/.exec(svg)?.[1] ?? "");
  const height = Number.parseFloat(/<svg[^>]*\sheight="([^"]+)"/.exec(svg)?.[1] ?? "");
  return width > 0 && height > 0 ? width / height : 1;
}

const wordmarks = new Map<string, Promise<{ src: string; aspect: number } | null>>();

/**
 * A wordmark of the site (site/brand/<file>, e.g. wordmark-dark.svg for the dark cards) as an
 * image of the given height; null when the pack has none, and the card sets the name in type instead.
 */
export async function brandMark(file: string, height: number): Promise<Node | null> {
  let mark = wordmarks.get(file);
  if (!mark) {
    mark = readFile(path.join(REPO_ROOT, "site/brand", file), "utf8").then(
      (svg) => ({ src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, aspect: aspect(svg) }),
      () => null,
    );
    wordmarks.set(file, mark);
  }
  const found = await mark;
  return found && h("img", { height }, undefined, { src: found.src, height, width: Math.round(height * found.aspect) });
}

/** The site name as a wordmark: bold, with the accent dot the cards use. */
export function nameMark(size: number, color: string, dot: string): Node {
  return h("div", { display: "flex", alignItems: "center" }, [
    h("div", { width: size * 0.36, height: size * 0.36, borderRadius: 999, backgroundColor: dot, marginRight: size * 0.28 }),
    h("div", { display: "flex", fontSize: size, fontWeight: 700, color, letterSpacing: 0.5 }, SITE.name),
  ]);
}

const ACCENTS = { teal: "#2ce2e8", hot: "#ff7a5f", amber: "#e2b454" } as const;

export function clamp(text: string, max: number) {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

// English on the cards. Noto Sans SC gives Latin letters their own widths (ASCII_WIDTHS); its curly quotes and en dash
// are as wide as a Chinese character, and it lacks most accented letters, so English is set with straight quotes, a
// hyphen and plain letters. Lines break between words, so English is fitted line by line.

/** Noto Sans SC's advance widths of printable ASCII (U+0020–U+007E), in thousandths of an em; tests check them against assets/og-fonts. */
export const ASCII_WIDTHS: Record<400 | 700, number[]> = {
  400: "224,323,474,555,555,921,680,278,338,338,467,555,278,347,278,392,555,555,555,555,555,555,555,555,555,555,278,278,555,555,555,474,946,608,657,638,688,589,552,689,728,293,535,646,543,812,723,742,633,742,635,596,599,721,575,878,573,531,603,338,392,338,555,559,606,563,618,510,620,554,325,564,607,275,275,552,284,926,610,606,620,620,388,468,377,607,521,802,498,521,475,338,270,338,555".split(",").map(Number),
  700: "227,370,574,590,590,963,740,325,378,378,507,590,325,370,325,387,590,590,590,590,590,590,590,590,590,590,325,325,590,590,590,514,1007,641,681,656,714,615,585,717,757,330,568,686,578,853,749,770,667,770,682,624,625,748,619,915,627,580,613,378,387,378,590,567,626,591,644,527,644,581,372,597,640,304,306,604,315,964,641,626,644,644,436,495,421,637,576,863,562,574,511,378,296,378,590".split(",").map(Number),
};

/** How wide text sets, in ems of its size: anything past ASCII as wide as a Chinese character. */
export function ems(text: string, weight: 400 | 700 = 700): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    width += code >= 0x20 && code <= 0x7e ? ASCII_WIDTHS[weight][code - 0x20]! / 1000 : 1;
  }
  return width;
}

/** English as the cards' font sets it well. */
export const plainEnglish = (text: string) =>
  text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/–/g, "-").replace(/\s+/g, " ").trim();

/** A word, or a piece of one wider than a line (a hash, an address: `broken`), which the cards break there (wordBreak: break-word). */
interface Token { text: string; gap: string; broken: boolean }

function tokens(text: string, room: number, weight: 400 | 700): Token[] {
  return text.split(" ").flatMap((word, i) => {
    const pieces = [""];
    for (const ch of word) {
      if (pieces.at(-1) && ems(pieces.at(-1)! + ch, weight) > room) pieces.push(ch);
      else pieces[pieces.length - 1] += ch;
    }
    return pieces.map((piece, j) => ({ text: piece, gap: i > 0 && j === 0 ? " " : "", broken: pieces.length > 1 }));
  });
}

const joined = (line: Token[]) => line.map((t, i) => (i ? t.gap : "") + t.text).join("");

/** Tokens laid into lines, each within `room` ems. */
function layout(all: Token[], room: number, weight: 400 | 700): Token[][] {
  const lines: Token[][] = [];
  for (const token of all) {
    const line = lines.at(-1);
    if (line && ems(joined([...line, token]), weight) <= room) line.push(token);
    else lines.push([token]);
  }
  return lines;
}

/** English broken into lines between words, each within `room` ems. */
export function wrapLines(text: string, room: number, weight: 400 | 700 = 700): string[] {
  return layout(tokens(text, room, weight), room, weight).map(joined);
}

/** English within `lines` lines of `room` ems, cut between words with an ellipsis (inside a word only wider than a line). */
export function fitLines(text: string, room: number, lines: number, weight: 400 | 700 = 700): string {
  const all = tokens(text, room, weight);
  if (layout(all, room, weight).length <= lines) return text;
  const kept = layout(all, room, weight).slice(0, lines).flat();
  while (wrapLines(`${joined(kept)}…`, room, weight).length > lines) {
    const last = kept.at(-1)!;
    // A piece of a word wider than a line gives up letters for the ellipsis, not its whole line.
    if (last.broken && [...last.text].length > 1) kept[kept.length - 1] = { ...last, text: [...last.text].slice(0, -1).join("") };
    else if (kept.length > 1) kept.pop();
    else break;
  }
  return `${joined(kept).replace(/[\s,;:.-]+$/, "")}…`;
}

export interface CardText { kicker: string; title: string; titleSize: number; subtitle: string | null; meta: string | null; english: boolean }

/**
 * What a card shows. An English card is set as English once its title and summary are; until then (its words not
 * translated yet) it is cut as Chinese is, which never lets a run of Chinese, unbroken by spaces, past the footer.
 */
export function cardText(card: OgCard): CardText {
  return card.lang === "en" && !needsEnglish(card.title) && !needsEnglish(card.subtitle) ? englishText(card) : chineseText(card);
}

/** A Chinese card's text: cut by characters. Long titles take three lines; the summary then gets one line so nothing reaches the footer. */
function chineseText(card: OgCard): CardText {
  const title = clamp(card.title, 64);
  const length = [...title].length;
  return {
    kicker: clamp(card.kicker, 30),
    title,
    titleSize: length > 40 ? 50 : length > 24 ? 58 : 66,
    subtitle: card.subtitle ? clamp(card.subtitle, length > 40 ? 26 : length > 24 ? 50 : 78) : null,
    meta: card.meta ? clamp(card.meta, 70) : null,
    english: false,
  };
}

/** Title sizes, largest first, with the lines each may take so a summary line still fits; past them the smallest, cut to three lines. */
const TITLE_SIZES: Array<[size: number, lines: number]> = [[66, 2], [58, 2], [50, 3]];
/** The text column (the badge and its gap take 210 of it) and the height the title and summary share, with and without the footer, keeping clear of it. */
const TEXT_WIDTH = WIDTH - 144;
const TEXT_HEIGHT = { meta: 272, bare: 330 };

/** An English card's text: the largest title size that keeps the title within its lines; the summary in the lines left. */
function englishText(card: OgCard): CardText {
  const room = TEXT_WIDTH - (card.badge ? 210 : 0);
  const title = plainEnglish(card.title);
  const [titleSize, most] = TITLE_SIZES.find(([size, lines]) => wrapLines(title, room / size).length <= lines) ?? TITLE_SIZES.at(-1)!;
  const titleLines = Math.min(most, wrapLines(title, room / titleSize).length);
  const left = Math.min(3, Math.floor((TEXT_HEIGHT[card.meta ? "meta" : "bare"] - titleLines * titleSize * 1.25 - 22) / 42));
  return {
    kicker: fitLines(plainEnglish(card.kicker), TEXT_WIDTH / 28 - 2, 1),
    title: fitLines(title, room / titleSize, most),
    titleSize,
    subtitle: card.subtitle && left > 0 ? fitLines(plainEnglish(card.subtitle), room / 28, left, 400) : null,
    meta: card.meta ? fitLines(plainEnglish(card.meta), TEXT_WIDTH / 24, 1, 400) : null,
    english: true,
  };
}

async function tree(card: OgCard): Promise<Node> {
  const accent = ACCENTS[card.accent ?? "teal"];
  const { kicker, title, titleSize, subtitle, meta, english } = cardText(card);
  // English breaks a word only wider than its line, where wrapLines does; Chinese keeps the styles it had.
  const wrap = english ? { wordBreak: "break-word" } : {};
  return h(
    "div",
    {
      width: WIDTH,
      height: HEIGHT,
      display: "flex",
      flexDirection: "column",
      padding: "64px 72px",
      fontFamily: "Noto Sans SC",
      color: "#e6eded",
      backgroundColor: "#0a1012",
      backgroundImage: "radial-gradient(circle at 88% 8%, rgba(44,226,232,0.28), rgba(10,16,18,0) 46%), radial-gradient(circle at 0% 100%, rgba(23,107,117,0.35), rgba(10,16,18,0) 50%)",
    },
    [
      h("div", { display: "flex", alignItems: "center", justifyContent: "space-between" }, [
        (await brandMark("wordmark-dark.svg", 40)) ?? nameMark(34, "#e6eded", "#2ce2e8"),
        h("div", { display: "flex", fontSize: 24, color: "#82939a" }, SITE_HOST),
      ]),
      h("div", { display: "flex", marginTop: 56, alignItems: "center" }, [
        h("div", { width: 10, height: 10, borderRadius: 999, backgroundColor: accent, marginRight: 14 }),
        h("div", { display: "flex", fontSize: 28, fontWeight: 700, color: accent, letterSpacing: 1, ...wrap }, kicker),
      ]),
      h("div", { display: "flex", flex: 1, marginTop: 22, gap: 40 }, [
        h("div", { display: "flex", flexDirection: "column", flex: 1 }, [
          h("div", { display: "flex", fontSize: titleSize, fontWeight: 700, lineHeight: 1.25, color: "#ffffff", ...wrap }, title),
          subtitle !== null ? h("div", { display: "flex", marginTop: 22, fontSize: 28, lineHeight: 1.5, color: "#b1bec0", ...wrap }, subtitle) : null,
        ].filter(Boolean)),
        card.badge
          ? h("div", { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: 170, height: 170, borderRadius: 999, border: `6px solid ${accent}` }, [
              h("div", { display: "flex", fontSize: 58, fontWeight: 700, color: "#ffffff" }, card.badge.value),
              h("div", { display: "flex", fontSize: 22, color: "#82939a" }, card.badge.label),
            ])
          : null,
      ].filter(Boolean)),
      meta !== null ? h("div", { display: "flex", fontSize: 24, color: "#82939a", borderTop: "1px solid rgba(230,237,237,0.12)", paddingTop: 22, ...wrap }, meta) : null,
    ].filter(Boolean),
  );
}

/**
 * Palette PNG at full quality with dithering: the flat card and its soft glow look the same as a
 * truecolour PNG at about half the bytes (117 → 62 KB for a typical article card). Share crawlers
 * keep getting PNG.
 */
const OG_PNG = { compressionLevel: 9, palette: true, quality: 100, dither: 1, effort: 10 } as const;

const inflight = new Map<string, Promise<Buffer>>();

/**
 * PNG bytes of a share image, from the disk cache (`name`.png) when it was rendered before. Concurrent
 * requests share one render; the file is written aside and moved into place, never read half-written.
 */
export function renderPng(name: string, size: { width: number; height: number }, tree: () => Promise<Node>): Promise<Buffer> {
  let job = inflight.get(name);
  if (!job) {
    job = render(path.join(CACHE_DIR, `${name}.png`), size, tree).finally(() => inflight.delete(name));
    inflight.set(name, job);
  }
  return job;
}

async function render(file: string, size: { width: number; height: number }, tree: () => Promise<Node>): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch {
    // not cached yet
  }
  const svg = await satori(await tree() as never, { ...size, fonts: await fonts() });
  const png = await sharp(Buffer.from(svg)).png(OG_PNG).toBuffer();
  await mkdir(CACHE_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, png);
  await rename(tmp, file);
  return png;
}

export function ogEtag(card: OgCard): string {
  // Added font names go into the key, so an image drawn before a font was added is drawn again; with none the key is unchanged.
  const hash = createHash("sha256").update(OG_TEMPLATE_VERSION).update(FALLBACK_FONTS.join());
  if (card.lang === "en") hash.update(ENGLISH_LAYOUT_VERSION);
  return hash.update(JSON.stringify(card)).digest("hex").slice(0, 24);
}

/** PNG bytes for a card, from the disk cache when this exact card was rendered before. */
export async function renderOg(card: OgCard): Promise<{ png: Buffer; etag: string }> {
  const etag = ogEtag(card);
  return { png: await renderPng(etag, { width: WIDTH, height: HEIGHT }, () => tree(card)), etag };
}
