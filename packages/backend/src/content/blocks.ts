import * as cheerio from "cheerio";
import { bodyToMarkdown, markdownToBody } from "./markdown.ts";
import { dropPageChrome, sanitizeBody, textToHtml } from "./sanitize.ts";
import { stripTags } from "../lib/text.ts";

export interface BodyRules {
  selector?: string;
  removeSelectors?: string[];
  images?: { keepSelectors?: string[]; removeSelectors?: string[] };
}

export interface BodyBlock {
  id: string;
  kind: "text" | "image";
  html: string;
  text: string;
  url?: string;
  alt?: string;
  caption?: string;
  section?: string;
  before?: string;
  after?: string;
  owner: string;
  rule?: "keep" | "remove";
}

/** Preserve image occurrences and their local context before sanitization drops CSS attributes. */
export function bodyBlocks(html: string, baseUrl: string, rules: BodyRules = {}, owner = "article"): BodyBlock[] {
  const $ = cheerio.load(dropPageChrome(html, rules.removeSelectors), null, false);
  const nodes = $.root().contents().toArray();
  const blocks: BodyBlock[] = [];
  let section = "";
  const appendText = (html: string) => {
    const clean = sanitizeBody(html, baseUrl);
    const text = stripTags(clean).trim();
    if (text) blocks.push({ id: `${owner}-b${blocks.length + 1}`, kind: "text", html: clean, text, owner });
  };
  const visit = (node: (typeof nodes)[number]): void => {
    if (node.type === "text") { if (node.data.trim()) appendText(textToHtml(node.data)); return; }
    if (node.type !== "tag") return;
    const el = $(node);
    if (["script", "style", "noscript", "template", "form", "iframe", "svg"].includes(node.name)) return;
    if (node.name === "img") {
      const clean = sanitizeBody($.html(node), baseUrl);
      const image = cheerio.load(clean, null, false)("img");
      const url = image.attr("src") ?? "";
      if (!/^https?:\/\//i.test(url)) return;
      const matches = (selectors: string[] = []) => selectors.some((s) => el.is(s) || el.parents(s).length > 0);
      const keep = matches(rules.images?.keepSelectors);
      const remove = matches(rules.images?.removeSelectors);
      if (keep && remove) throw new Error("图片同时匹配保留和排除规则，请修正信源配置");
      blocks.push({ id: `${owner}-b${blocks.length + 1}`, kind: "image", html: clean, text: "", url,
        alt: image.attr("alt") ?? "", caption: el.closest("figure").find("figcaption").text().trim(), section, owner,
        rule: keep ? "keep" : remove ? "remove" : undefined });
      return;
    }
    if (/^h[1-6]$/.test(node.name)) section = el.text().trim();
    if (/^(ul|ol|blockquote|pre)$/.test(node.name) && !el.find("img").length) { appendText($.html(node)); return; }
    if (node.name === "p" && el.find("img").length) {
      // Preserve text before and after inline images, including their inline formatting.
      let fragment = "";
      const flush = () => { if (fragment) appendText(`<p>${fragment}</p>`); fragment = ""; };
      const inline = (child: (typeof nodes)[number]) => {
        if (child.type === "tag" && child.name === "img") { flush(); visit(child); }
        else if (child.type === "tag" && $(child).find("img").length) $(child).contents().toArray().forEach(inline);
        else fragment += $.html(child);
      };
      el.contents().toArray().forEach(inline);
      flush();
      return;
    }
    if (node.name === "table" || (!el.find("p,div,section,article,figure,table,ul,ol,h1,h2,h3,h4").length && /^(p|h[1-6]|li|blockquote|pre|figcaption)$/.test(node.name))) {
      const copy = el.clone();
      copy.find("img").remove();
      appendText($.html(copy));
      el.find("img").toArray().forEach(visit);
    } else el.contents().toArray().forEach(visit);
  };
  nodes.forEach(visit);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind !== "image") continue;
    b.before = blocks.slice(0, i).filter((x) => x.kind === "text").slice(-2).map((x) => x.text).join("\n").slice(-1600);
    b.after = blocks.slice(i + 1).filter((x) => x.kind === "text").slice(0, 2).map((x) => x.text).join("\n").slice(0, 1600);
  }
  return blocks;
}

/** Model transcriptions may contain tables, but cannot introduce links, images or executable HTML. */
export function cleanTranscription(markdown: string): string {
  const $ = cheerio.load(markdownToBody(markdown), null, false);
  $("img,video,picture").remove();
  $("a").each((_, el) => { $(el).replaceWith($(el).contents()); });
  return bodyToMarkdown($.html());
}

export function imageContext(block: BodyBlock) {
  return { imageId: block.id, owner: block.owner, alt: block.alt, caption: block.caption,
    section: block.section, before: block.before, after: block.after, keep: block.rule === "keep" };
}
