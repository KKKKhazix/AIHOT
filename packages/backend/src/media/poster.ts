// Share posters (1080×1440 PNG) for articles, made for phones: saved from the page or long-pressed in
// chat apps. Same font pipeline as the share cards; the QR code opens the article on the site.
import { createHash } from "node:crypto";
import { renderSVG } from "uqr";
import { ENGLISH, needsEnglish } from "@aihot/contracts/english";
import { SITE } from "@aihot/site";
import { brandMark, clamp, ENGLISH_LAYOUT_VERSION, FALLBACK_FONTS, fitLines, h, nameMark, plainEnglish, renderPng, SITE_HOST, wrapLines, type Node } from "./og.ts";

export const POSTER_TEMPLATE_VERSION = "poster-2026-09-29.1";
const WIDTH = 1080;
const HEIGHT = 1440;

export interface Poster {
  url: string;
  kicker: string;
  title: string;
  summary: string | null;
  source: string;
  date: string;
  score: number | null;
  /** Set only on an English poster (its QR code opens the English page), which is set as English (englishText). */
  lang?: "en";
}

const INK = "#0e191b";
const ACCENT = "#176b75";

/** The poster's own words. */
interface Words { score: (n: number) => string; source: (name: string) => string; scan: string; read: string; tagline: string }
const WORDS: Record<"zh" | "en", Words> = {
  zh: { score: (n: number) => `精选 · ${n} 分`, source: (name: string) => `来源：${name}`, scan: "长按识别二维码", read: "阅读全文、中文译文与原文链接", tagline: SITE.tagline },
  en: { score: (n: number) => `Top Pick · AI score ${n}`, source: (name: string) => `Source: ${name}`, scan: "Scan to read", read: "The summary and a link to the original", tagline: ENGLISH?.tagline ?? SITE.tagline },
};

/** Every word a poster shows: its text, and its own words in the poster's language. */
export interface PosterText {
  kicker: string; title: string; titleSize: number; summary: string | null; source: string;
  score: string | null; scan: string; read: string; footer: string; date: string; host: string; english: boolean;
}

/** What a poster shows: as og.ts cardText, an English poster is set as English once its title and summary are. */
export function posterText(p: Poster): PosterText {
  const words = WORDS[p.lang ?? "zh"];
  const text = p.lang === "en" && !needsEnglish(p.title) && !needsEnglish(p.summary) ? englishText(p) : chineseText(p, words);
  return {
    ...text, score: p.score !== null ? words.score(Math.round(p.score)) : null, scan: words.scan, read: words.read,
    footer: `${SITE.name} · ${words.tagline}`, date: p.date, host: SITE_HOST,
  };
}

type SetText = Omit<PosterText, "score" | "scan" | "read" | "footer" | "date" | "host">;

/** A poster's text cut by characters, as Chinese is: the summary takes the room the title leaves. */
function chineseText(p: Poster, words: Words): SetText {
  const title = clamp(p.title, 72);
  const len = [...title].length;
  return {
    kicker: clamp(p.kicker, 20),
    title,
    titleSize: len > 48 ? 58 : len > 30 ? 66 : 76,
    summary: p.summary ? clamp(p.summary, len > 48 ? 120 : len > 30 ? 150 : 180) : null,
    source: clamp(words.source(p.source), 34),
    english: false,
  };
}

/** Title sizes, largest first, with the lines each may take (og.ts fits English by lines); the text column and the height title and summary share. */
const TITLE_SIZES: Array<[size: number, lines: number]> = [[76, 3], [66, 4], [58, 5]];
const TEXT_WIDTH = WIDTH - 176;
const TEXT_HEIGHT = 600;

function englishText(p: Poster): SetText {
  const title = plainEnglish(p.title);
  const [titleSize, most] = TITLE_SIZES.find(([size, lines]) => wrapLines(title, TEXT_WIDTH / size).length <= lines) ?? TITLE_SIZES.at(-1)!;
  const left = Math.min(6, Math.floor((TEXT_HEIGHT - Math.min(most, wrapLines(title, TEXT_WIDTH / titleSize).length) * titleSize * 1.3) / (34 * 1.7)));
  return {
    // The kicker shares its line with the score.
    kicker: fitLines(plainEnglish(p.kicker), 16, 1),
    title: fitLines(title, TEXT_WIDTH / titleSize, most),
    titleSize,
    summary: p.summary && left > 0 ? fitLines(plainEnglish(p.summary), TEXT_WIDTH / 34, left, 400) : null,
    source: fitLines(plainEnglish(WORDS.en.source(p.source)), TEXT_WIDTH / 28, 1, 400),
    english: true,
  };
}

async function tree(p: Poster): Promise<Node> {
  // Every word comes from posterText. English breaks a word only wider than its line, where og.ts wrapLines does.
  const { kicker, title, titleSize, summary, source, score, scan, read, footer, date, host, english } = posterText(p);
  const wrap = english ? { wordBreak: "break-word" } : {};
  const qr = `data:image/svg+xml;base64,${Buffer.from(renderSVG(p.url, { border: 0, ecc: "M", blackColor: INK, whiteColor: "#ffffff" })).toString("base64")}`;
  return h(
    "div",
    {
      width: WIDTH,
      height: HEIGHT,
      display: "flex",
      flexDirection: "column",
      padding: "84px 88px 72px",
      fontFamily: "Noto Sans SC",
      color: INK,
      backgroundColor: "#f5f6f5",
      backgroundImage: "radial-gradient(circle at 100% 0%, rgba(23,107,117,0.16), rgba(245,246,245,0) 52%), radial-gradient(circle at 0% 100%, rgba(44,226,232,0.10), rgba(245,246,245,0) 45%)",
    },
    [
      h("div", { display: "flex", alignItems: "center", justifyContent: "space-between" }, [
        (await brandMark("wordmark.svg", 50)) ?? nameMark(44, INK, ACCENT),
        h("div", { display: "flex", fontSize: 26, color: "#66757a" }, date),
      ]),
      h("div", { display: "flex", alignItems: "center", marginTop: 96 }, [
        h("div", { width: 12, height: 12, borderRadius: 999, backgroundColor: ACCENT, marginRight: 16 }),
        h("div", { display: "flex", fontSize: 30, fontWeight: 700, color: ACCENT, letterSpacing: 1, ...wrap }, kicker),
        score !== null
          ? h("div", { display: "flex", marginLeft: 20, padding: "4px 16px", borderRadius: 999, backgroundColor: "rgba(23,107,117,0.09)", fontSize: 26, color: "#0f5a63" }, score)
          : null,
      ].filter(Boolean)),
      h("div", { display: "flex", marginTop: 30, fontSize: titleSize, fontWeight: 700, lineHeight: 1.3, color: INK, ...wrap }, title),
      summary ? h("div", { display: "flex", marginTop: 36, fontSize: 34, lineHeight: 1.7, color: "#3a484c", ...wrap }, summary) : null,
      h("div", { display: "flex", marginTop: 36, fontSize: 28, color: "#66757a", ...wrap }, source),
      h("div", { display: "flex", flex: 1 }),
      h(
        "div",
        { display: "flex", alignItems: "center", padding: "36px 40px", borderRadius: 32, backgroundColor: "#ffffff", boxShadow: "0 1px 2px rgba(14,25,27,0.06), 0 12px 32px rgba(14,25,27,0.07)" },
        [
          h("img", { width: 200, height: 200 }, undefined, { src: qr, width: 200, height: 200 }),
          h("div", { display: "flex", flexDirection: "column", marginLeft: 44, flex: 1 }, [
            h("div", { display: "flex", fontSize: 36, fontWeight: 700, color: INK }, scan),
            h("div", { display: "flex", marginTop: 14, fontSize: 28, lineHeight: 1.5, color: "#66757a" }, read),
            h("div", { display: "flex", marginTop: 22, fontSize: 26, color: ACCENT }, host),
          ]),
        ],
      ),
      h("div", { display: "flex", justifyContent: "center", marginTop: 40, fontSize: 24, color: "#98a4a7" }, footer),
    ].filter(Boolean),
  );
}

export function posterEtag(p: Poster): string {
  const hash = createHash("sha256").update(POSTER_TEMPLATE_VERSION).update(FALLBACK_FONTS.join());
  if (p.lang === "en") hash.update(ENGLISH_LAYOUT_VERSION);
  return hash.update(JSON.stringify(p)).digest("hex").slice(0, 24);
}

/** PNG bytes for a poster, from the disk cache when this exact poster was rendered before. */
export async function renderPoster(p: Poster): Promise<{ png: Buffer; etag: string }> {
  const etag = posterEtag(p);
  return { png: await renderPng(`poster-${etag}`, { width: WIDTH, height: HEIGHT }, () => tree(p)), etag };
}
