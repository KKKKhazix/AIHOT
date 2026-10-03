// Share posters (1080×1440 PNG) for articles, made for phones: saved from the page or long-pressed in
// chat apps. Same font pipeline as the share cards; the QR code opens the article on the site.
import { createHash } from "node:crypto";
import { renderSVG } from "uqr";
import { SITE } from "@aihot/site";
import { brandMark, clamp, h, nameMark, renderPng, SITE_HOST, type Node } from "./render.ts";

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
}

const INK = "#0e191b";
const ACCENT = "#176b75";

async function tree(p: Poster): Promise<Node> {
  const title = clamp(p.title, 72);
  const len = [...title].length;
  const titleSize = len > 48 ? 58 : len > 30 ? 66 : 76;
  // The summary takes the room the title leaves.
  const summary = p.summary ? clamp(p.summary, len > 48 ? 120 : len > 30 ? 150 : 180) : null;
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
        h("div", { display: "flex", fontSize: 26, color: "#66757a" }, p.date),
      ]),
      h("div", { display: "flex", alignItems: "center", marginTop: 96 }, [
        h("div", { width: 12, height: 12, borderRadius: 999, backgroundColor: ACCENT, marginRight: 16 }),
        h("div", { display: "flex", fontSize: 30, fontWeight: 700, color: ACCENT, letterSpacing: 1 }, clamp(p.kicker, 20)),
        p.score !== null
          ? h("div", { display: "flex", marginLeft: 20, padding: "4px 16px", borderRadius: 999, backgroundColor: "rgba(23,107,117,0.09)", fontSize: 26, color: "#0f5a63" }, `精选 · ${Math.round(p.score)} 分`)
          : null,
      ].filter(Boolean)),
      h("div", { display: "flex", marginTop: 30, fontSize: titleSize, fontWeight: 700, lineHeight: 1.3, color: INK }, title),
      summary ? h("div", { display: "flex", marginTop: 36, fontSize: 34, lineHeight: 1.7, color: "#3a484c" }, summary) : null,
      h("div", { display: "flex", marginTop: 36, fontSize: 28, color: "#66757a" }, clamp(`来源：${p.source}`, 34)),
      h("div", { display: "flex", flex: 1 }),
      h(
        "div",
        { display: "flex", alignItems: "center", padding: "36px 40px", borderRadius: 32, backgroundColor: "#ffffff", boxShadow: "0 1px 2px rgba(14,25,27,0.06), 0 12px 32px rgba(14,25,27,0.07)" },
        [
          h("img", { width: 200, height: 200 }, undefined, { src: qr, width: 200, height: 200 }),
          h("div", { display: "flex", flexDirection: "column", marginLeft: 44, flex: 1 }, [
            h("div", { display: "flex", fontSize: 36, fontWeight: 700, color: INK }, "长按识别二维码"),
            h("div", { display: "flex", marginTop: 14, fontSize: 28, lineHeight: 1.5, color: "#66757a" }, "阅读全文、中文译文与原文链接"),
            h("div", { display: "flex", marginTop: 22, fontSize: 26, color: ACCENT }, SITE_HOST),
          ]),
        ],
      ),
      h("div", { display: "flex", justifyContent: "center", marginTop: 40, fontSize: 24, color: "#98a4a7" }, `${SITE.name} · ${SITE.tagline}`),
    ].filter(Boolean),
  );
}

export function posterEtag(p: Poster): string {
  return createHash("sha256").update(POSTER_TEMPLATE_VERSION).update(JSON.stringify(p)).digest("hex").slice(0, 24);
}

/** PNG bytes for a poster, from the disk cache when this exact poster was rendered before. */
export async function renderPoster(p: Poster): Promise<{ png: Buffer; etag: string }> {
  const etag = posterEtag(p);
  return { png: await renderPng(`poster-${etag}`, { width: WIDTH, height: HEIGHT }, () => tree(p)), etag };
}
