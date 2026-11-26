import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ENGLISH } from "@aihot/contracts/english";
import { SITE } from "@aihot/site";

const dir = await mkdtemp(path.join(tmpdir(), "aihot-media-test-"));
process.env.AIHOT_DATA_DIR = dir;
process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true";
process.env.MODEL_CALLS_ENABLED = "false";
const { produceImage } = await import("@aihot/backend/media/images");
const { renderOg, ogEtag, fallbackFontFiles, FALLBACK_FONTS, OG_TEMPLATE_VERSION, ENGLISH_LAYOUT_VERSION, ASCII_WIDTHS, cardText, ems, fitLines, plainEnglish, wrapLines } = await import("@aihot/backend/media/og");
const { REPO_ROOT } = await import("@aihot/backend/config");
const { posterEtag, posterText, renderPoster, POSTER_TEMPLATE_VERSION } = await import("@aihot/backend/media/poster");
const { xView } = await import("@aihot/backend/publication/items");

let imageHits = 0;
let failureHits = 0;
let refusalHits = 0;
let animationHits = 0;
const png = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#176b75" } }).png().toBuffer();
const separator = await sharp({ create: { width: 2920, height: 10, channels: 3, background: "#176b75" } }).png().toBuffer();
// A photo-like JPEG (gradients and soft shapes) that AVIF encodes in far fewer bytes at the same sharpness.
const photo = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d3557"/><stop offset="0.5" stop-color="#e9c46a"/><stop offset="1" stop-color="#e76f51"/></linearGradient><radialGradient id="r"><stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><rect width="1600" height="900" fill="url(#g)"/><circle cx="480" cy="360" r="260" fill="url(#r)"/><circle cx="1180" cy="560" r="180" fill="#2a9d8f" opacity="0.7"/><rect x="760" y="140" width="320" height="200" rx="40" fill="#264653" opacity="0.6"/></svg>`)).jpeg({ quality: 95 }).toBuffer();
// Ten noisy 160×120 frames: a GIF that animated WebP clearly beats.
const frames = await sharp({ create: { width: 160, height: 1200, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 40 } } }).raw().toBuffer();
const animatedGif = await sharp(frames, { raw: { width: 160, height: 1200, channels: 3, pageHeight: 120 } }).gif({ loop: 0, delay: Array(10).fill(90) }).toBuffer();
const tinyGif = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).gif({ loop: 2, delay: [80, 160] }).toBuffer();
// Inflate the two image descriptors only: metadata exceeds the decode budget without actually
// allocating hundreds of millions of pixels in this test (or on an HTTP request).
const overBudgetGif = Buffer.from(tinyGif);
const descriptor = Buffer.from([44, 0, 0, 0, 0, 1, 0, 1, 0]);
for (let at = overBudgetGif.indexOf(descriptor); at !== -1; at = overBudgetGif.indexOf(descriptor, at + 9)) {
  overBudgetGif.writeUInt16LE(11000, at + 5);
  overBudgetGif.writeUInt16LE(11000, at + 7);
}
const server = createServer(async (req, res) => {
  if (req.url === "/separator.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(separator); }
  if (req.url === "/large-source.gif") {
    res.writeHead(200, { "content-type": "image/gif" });
    res.write(animatedGif);
    return res.end(Buffer.alloc(16 * 1024 * 1024));
  }
  if (req.url === "/anim.gif") { animationHits++; res.writeHead(200, { "content-type": "image/gif" }); return res.end(animatedGif); }
  if (req.url === "/tiny.gif") { res.writeHead(200, { "content-type": "image/gif" }); return res.end(tinyGif); }
  if (req.url === "/photo.jpg") { res.writeHead(200, { "content-type": "image/jpeg" }); return res.end(photo); }
  if (req.url === "/over-budget.gif") { res.writeHead(200, { "content-type": "image/gif" }); return res.end(overBudgetGif); }
  if (req.url === "/binary-image") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(png); }
  if (req.url === "/binary-alias") { res.writeHead(200, { "content-type": "binary/octet-stream" }); return res.end(png); }
  if (req.url === "/binary-alias-error") { res.writeHead(200, { "content-type": "binary/octet-stream" }); return res.end("<html>Not an image</html>"); }
  if (req.url === "/binary-error") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end("<html>Image not found</html>"); }
  if (req.url === "/fail") { failureHits++; res.writeHead(502); return res.end(); }
  if (req.url === "/gone") { refusalHits++; res.writeHead(404); return res.end(); }
  if (req.url === "/refused") { refusalHits++; res.writeHead(403); return res.end(); }
  imageHits++;
  res.writeHead(200, { "content-type": "image/png" });
  res.end(png);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { closeDb } = await import("@aihot/backend/db");
  const { stopBoss } = await import("@aihot/backend/jobs/queue");
  await stopBoss();
  await closeDb();
  await rm(dir, { recursive: true, force: true });
});

test("simultaneous modes share original bytes, preserve dimensions and use their disk caches", async () => {
  const [thumb, full, avatar, card] = await Promise.all([produceImage(`${base}/image`, "thumb"), produceImage(`${base}/image`, "full"), produceImage(`${base}/image`, "avatar"), produceImage(`${base}/image`, "card")]);
  assert.equal(imageHits, 1);
  assert.deepEqual(await Promise.all([thumb, full, avatar, card].map(async (image) => (await sharp(image.body).metadata()).width)), [720, 800, 96, 336]);
  assert.deepEqual(await produceImage(`${base}/image`, "thumb"), thumb);
  assert.equal(imageHits, 1);
});

test("failed originals are not retried for every mode", async () => {
  await assert.rejects(produceImage(`${base}/fail`, "thumb"));
  await assert.rejects(produceImage(`${base}/fail`, "full"));
  assert.equal(failureHits, 1);
});

// A previous encoder's disk entry must not bypass today's rendition rules, refetch the source,
// rasterize a compact vector, or expose a mismatched MIME while body/type files are replaced.
test("cached oversized SVGs use current renditions without downloading them again", async () => {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#176b75"/><desc>${randomBytes(180000).toString("base64")}</desc></svg>`);
  const url = `${base}/cached-vector`;
  const key = createHash("sha256").update(`full|${url}`).digest("hex");
  const file = path.join(dir, "imgcache", key.slice(0, 2), key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, svg);
  await writeFile(`${file}.type`, "image/svg+xml");
  const before = imageHits;
  const first = await produceImage(url, "full");
  assert.equal(first.type, "image/webp");
  const meta = await sharp(first.body).metadata();
  assert.deepEqual([meta.width, meta.height], [1600, 900]);
  assert.ok(first.body.length < svg.length / 10);
  assert.deepEqual(await produceImage(url, "full"), first);
  // Another serving process can read the old MIME alongside the new body, or the reverse.
  await writeFile(`${file}.type`, "image/svg+xml");
  assert.deepEqual(await produceImage(url, "full"), first);
  await writeFile(file, svg);
  await writeFile(`${file}.type`, "image/webp");
  assert.deepEqual(await produceImage(url, "full"), first);
  const smallUrl = `${base}/compact-vector`;
  const smallKey = createHash("sha256").update(`full|${smallUrl}`).digest("hex");
  const smallFile = path.join(dir, "imgcache", smallKey.slice(0, 2), smallKey);
  const compact = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8"/></svg>');
  await mkdir(path.dirname(smallFile), { recursive: true });
  await writeFile(smallFile, compact);
  await writeFile(`${smallFile}.type`, "image/svg+xml");
  assert.deepEqual(await produceImage(smallUrl, "full"), { body: compact, type: "image/svg+xml" });
  assert.equal(imageHits, before);
});

// SVG can be much smaller over HTTP than its disk size, and its intrinsic display width is
// independent of a bitmap's pixel count. Neither may regress just to change the image format.
test("SVG preparation retains compact transfer and intrinsic display size", async () => {
  const { resizeImage } = await import("@aihot/backend/media/images");
  const compactTransfer = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#176b75"/><desc>${"compressible metadata ".repeat(10000)}</desc></svg>`);
  const smallDisplay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="34"><rect width="180" height="34" fill="#176b75"/><desc>${randomBytes(180000).toString("base64")}</desc></svg>`);
  for (const [name, body] of [["compact-transfer", compactTransfer], ["small-display", smallDisplay]] as const) {
    assert.deepEqual(await resizeImage(body, "image/svg+xml", "full"), { body, type: "image/svg+xml" });
    const url = `${base}/${name}`;
    const key = createHash("sha256").update(`full|${url}`).digest("hex");
    const file = path.join(dir, "imgcache", key.slice(0, 2), key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    await writeFile(`${file}.type`, "image/svg+xml");
    assert.deepEqual(await produceImage(url, "full"), { body, type: "image/svg+xml" });
    assert.equal(await readFile(`${file}.prepared`, "utf8"), "original");
    assert.deepEqual(await produceImage(url, "full"), { body, type: "image/svg+xml" });
  }
});

test("a retained large SVG still supplies the model's raster thumbnail", async () => {
  const { firstImagePart } = await import("@aihot/backend/editorial/input");
  const url = `${base}/model-vector`;
  const key = createHash("sha256").update(`thumb|${url}`).digest("hex");
  const file = path.join(dir, "imgcache", key.slice(0, 2), key);
  const body = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="34"><rect width="180" height="34" fill="#176b75"/><desc>${randomBytes(180000).toString("base64")}</desc></svg>`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  await writeFile(`${file}.type`, "image/svg+xml");
  const before = imageHits;
  const part = await firstImagePart({ media: [{ kind: "image", url }] } as Parameters<typeof firstImagePart>[0]);
  assert.ok(part && part.type === "image_url");
  const data = (part as { type: "image_url"; image_url: { url: string } }).image_url.url;
  assert.match(data, /^data:image\/(jpeg|png|webp);base64,/);
  assert.equal((await sharp(Buffer.from(data.split(",")[1]!, "base64")).metadata()).width, 720);
  assert.equal(imageHits, before);
});

test("model inputs retain thin images within the provider's minimum dimensions", async () => {
  const { firstImagePart, loadArticleImageParts } = await import("@aihot/backend/editorial/input");
  const url = `${base}/separator.png`;
  const narrow = await sharp({ create: { width: 1, height: 80, channels: 3, background: "#176b75" } }).png().toBuffer();
  const loaded = await loadArticleImageParts([url, `data:image/png;base64,${narrow.toString("base64")}`, `${base}/image`]);
  assert.equal(loaded.parts.length, 3, "thin images must still be reviewed");
  assert.equal(loaded.unverifiedCount, 0);
  const first = await firstImagePart({ media: [{ kind: "image", url }] });
  assert.ok(first);
  const bodies = [...loaded.parts, first].map((part) => {
    assert.equal(part.type, "image_url");
    return Buffer.from((part as { image_url: { url: string } }).image_url.url.split(",")[1]!, "base64");
  });
  for (const body of bodies) {
    const meta = await sharp(body).metadata();
    assert.ok(meta.width! > 10 && meta.height! > 10, "the provider rejects either dimension at 10 or below");
  }
  assert.deepEqual(bodies[2], (await produceImage(`${base}/image`, "thumb")).body, "ordinary images retain their bytes");
});

test("site media exposes responsive previews and full lightboxes while RSS retains thumb images", () => {
  const row = { zh_text: null, x_post: { media: [{ url: "https://example.org/1.png" }, { url: "https://example.org/2.png", poster: "https://example.org/poster.png" }] } };
  assert.ok(xView(row, true)!.media.every((m) => m.url.includes("mode=card") && m.fullUrl?.includes("mode=full")));
  assert.ok(xView(row, true)!.media[1]!.poster!.includes("mode=card"));
  assert.ok(xView(row)!.media.every((m) => m.url.includes("mode=thumb") && m.fullUrl === undefined));
  const detail = xView(row, false, true)!.media;
  assert.ok(detail.every((m) => m.url.includes("mode=reading") && m.fullUrl?.includes("mode=full") && !m.srcSet));
  row.x_post.media[1]!.url = "javascript:invalid";
  const single = xView(row, true)!.media;
  assert.equal(single.length, 1);
  assert.ok(single[0]!.url.includes("mode=thumb"));
});

test("concurrent cold OG and poster requests all succeed with identical cached bytes", async () => {
  const card = { kicker: SITE.name, title: "并发渲染验证", subtitle: "同一图片只生成一次" };
  const cards = await Promise.all(Array.from({ length: 3 }, () => renderOg(card)));
  for (const result of cards) assert.deepEqual(result, cards[0]);
  assert.equal((await sharp(cards[0]!.png).metadata()).width, 1200);
  const poster = { url: "https://example.com/items/test", kicker: SITE.name, title: "海报并发验证", summary: null, source: SITE.name, date: "2026-09-28", score: null };
  const posters = await Promise.all(Array.from({ length: 2 }, () => renderPoster(poster)));
  for (const result of posters) assert.deepEqual(result, posters[0]);
  assert.equal((await sharp(posters[0]!.png).metadata()).width, 1080);
});

test("share images take added fonts only from <name>-400/-700.ttf beside Noto Sans SC", () => {
  const files = ["LICENSE", "noto-sans-sc-700.ttf", "noto-sans-kr-700.ttf", "noto-sans-sc-400.ttf", "noto-sans-kr-400.ttf", "extra.otf", "extra-500.ttf", "-400.ttf"];
  assert.deepEqual(fallbackFontFiles(files), ["noto-sans-kr-400.ttf", "noto-sans-kr-700.ttf"]);
  assert.deepEqual(fallbackFontFiles(["LICENSE", "noto-sans-sc-400.ttf", "noto-sans-sc-700.ttf"]), []);
});

test("English cards measure Latin type by the font's own widths", async () => {
  // opentype.js (a development dependency) ships no types.
  type Font = { unitsPerEm: number; charToGlyph(ch: string): { advanceWidth?: number } };
  const opentype = (await import("opentype.js" as string)).default as { parse(data: ArrayBuffer): Font };
  for (const weight of [400, 700] as const) {
    const file = await readFile(path.join(REPO_ROOT, `assets/og-fonts/noto-sans-sc-${weight}.ttf`));
    const font = opentype.parse(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer);
    const widths = Array.from({ length: 95 }, (_, i) => Math.round((font.charToGlyph(String.fromCharCode(0x20 + i)).advanceWidth ?? 0) / font.unitsPerEm * 1000));
    assert.deepEqual(ASCII_WIDTHS[weight], widths, `ASCII_WIDTHS[${weight}] in media/og.ts: read it again from assets/og-fonts/noto-sans-sc-${weight}.ttf`);
  }
});

test("English cards break between words and cut with an ellipsis, in marks the font sets well", () => {
  assert.equal(plainEnglish("Anthropic’s “Claude” – Pokémon  "), `Anthropic's "Claude" - Pokemon`);
  const room = ems("one two three");
  const cut = fitLines("one two three four five six seven eight nine ten", room, 2);
  assert.equal(cut, "one two three four five six…");
  assert.ok(wrapLines(cut, room).length <= 2);
  assert.equal(fitLines("one two", room, 1), "one two", "what fits is left whole");
  assert.equal(plainEnglish("가나 ガ"), "가나 ガ", "letters of other scripts come back whole");
  // A word wider than a line (a commit hash, an address) is broken where the cards break it, and cut inside if need be.
  const hash = "3f9a8c1d2e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b";
  const lines = wrapLines(`reverts ${hash} today`, room);
  assert.ok(lines.length > 2 && lines.every((line) => ems(line) <= room) && lines.join("").replace(/ /g, "") === `reverts${hash}today`, lines.join(" | "));
  const cutHash = fitLines(`reverts ${hash} today`, room, 2);
  assert.ok(cutHash.endsWith("…") && wrapLines(cutHash, room).length <= 2 && `reverts ${hash}`.startsWith(cutHash.slice(0, -1)), cutHash);
  // The ellipsis takes letters from such a word, not the word's whole line: what fits of it stays.
  const url = "https://git.example.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=3f9a8c1d2e7b6a5f4c3d";
  const cutUrl = fitLines(`See ${url} for details`, room, 2);
  assert.ok(cutUrl.endsWith("…") && wrapLines(cutUrl, room).length <= 2 && cutUrl.length > "See https://git".length && `See ${url}`.startsWith(cutUrl.slice(0, -1)), cutUrl);
});

test("an English card or poster whose words are still Chinese is cut as Chinese, never left whole", () => {
  const [title, summary] = ["中".repeat(90), "文".repeat(200)];
  const card = cardText({ kicker: "Model Releases", title, subtitle: summary, meta: "Source · November 24, 2026", badge: { value: "88", label: "AI score" }, lang: "en" });
  assert.deepEqual([[...card.title].length, [...card.subtitle!].length, card.titleSize], [64, 26, 50]);
  const english = cardText({ kicker: "Model Releases", title: "word ".repeat(40), subtitle: "word ".repeat(80), meta: "Source", lang: "en" });
  assert.ok(english.title.endsWith("…") && english.subtitle!.endsWith("…"), "English is cut between words");
  const poster = posterText({ url: "https://example.test/en/items/a", kicker: "Research", title, summary, source: "来源名", date: "November 24, 2026", score: 88, lang: "en" });
  assert.deepEqual([[...poster.title].length, [...poster.summary!].length, poster.source], [72, 120, "Source: 来源名"]);
});

// A site without an English edition draws no English poster (its tagline has no English).
test("everything an English poster says is English; a Chinese one says what it always did", { skip: ENGLISH === null }, () => {
  const base = { url: "https://example.test/items/a", kicker: "Research", title: "A small model matches big ones", summary: "It was trained on proofs it wrote.", source: "Example", date: "November 24, 2026", score: 88 };
  const english = posterText({ ...base, lang: "en" });
  assert.ok(english.english && english.scan === "Scan to read" && english.score === "Top Pick · AI score 88" && english.footer.startsWith(`${SITE.name} · `));
  assert.doesNotMatch(JSON.stringify(english), /[\u3400-\u9fff]/, "no Chinese anywhere on it");
  const chinese = posterText({ ...base, kicker: "研究", title: "小模型追平大模型", summary: "它用自己写的证明训练。" });
  assert.deepEqual([chinese.english, chinese.scan, chinese.score, chinese.footer], [false, "长按识别二维码", "精选 · 88 分", `${SITE.name} · ${SITE.tagline}`]);
});

test("without added fonts, share images and posters keep their cache keys", { skip: FALLBACK_FONTS.length > 0 }, () => {
  const card = { kicker: SITE.name, title: "缓存键不变", subtitle: null };
  assert.equal(ogEtag(card), createHash("sha256").update(OG_TEMPLATE_VERSION).update(JSON.stringify(card)).digest("hex").slice(0, 24));
  const poster = { url: "https://example.test/a", kicker: "精选", title: "缓存键不变", summary: null, source: "来源", date: "2026-11-01", score: null };
  assert.equal(posterEtag(poster), createHash("sha256").update(POSTER_TEMPLATE_VERSION).update(JSON.stringify(poster)).digest("hex").slice(0, 24));
  // English images carry how English is set, so a change to it draws them again; the Chinese keys above stay.
  const english = { ...card, lang: "en" as const };
  assert.equal(ogEtag(english), createHash("sha256").update(OG_TEMPLATE_VERSION).update(ENGLISH_LAYOUT_VERSION).update(JSON.stringify(english)).digest("hex").slice(0, 24));
  const englishPoster = { ...poster, lang: "en" as const };
  assert.equal(posterEtag(englishPoster), createHash("sha256").update(POSTER_TEMPLATE_VERSION).update(ENGLISH_LAYOUT_VERSION).update(JSON.stringify(englishPoster)).digest("hex").slice(0, 24));
});

test("successive responsive candidates reuse the completed original download", async () => {
  const before = imageHits;
  const url = `${base}/successive`;
  const small = await produceImage(url, "card");
  const large = await produceImage(url, "image-1200");
  const avatar = await produceImage(url, "avatar-48");
  assert.equal(imageHits - before, 1);
  assert.deepEqual(await Promise.all([small, large, avatar].map(async (image) => (await sharp(image.body).metadata()).width)), [336, 800, 48]);
});

test("responsive URLs and web body candidates retain exact signatures and stable expiry", async () => {
  const { proxiedImageSet, proxyBodyImages, verifyProxyRequest } = await import("@aihot/backend/media/imgproxy");
  const now = Date.parse("2026-09-28T08:00:00Z");
  const candidates = proxiedImageSet("https://example.org/image.png", "card", false, now)!;
  assert.equal(candidates, proxiedImageSet("https://example.org/image.png", "card", false, now + 1000));
  for (const candidate of candidates.split(", ")) {
    const [value, width] = candidate.split(" ");
    const u = new URL(value!, "http://localhost");
    assert.deepEqual([...u.searchParams.keys()].sort(), ["exp", "mode", "sig", "u"]);
    const query = Object.fromEntries(u.searchParams);
    assert.equal(verifyProxyRequest(query, now).ok, true);
    assert.equal(width, query.mode === "card" ? "336w" : "720w");
    assert.equal(verifyProxyRequest({ ...query, mode: "full" }, now).ok, false);
  }
  const html = '<p><img src="https://example.org/image.png?a=1&amp;b=2" width="800" height="400"></p>';
  assert.ok(!proxyBodyImages('<img src="https://example.org/small.png" width="160" height="80">').includes('srcset='));
  assert.ok(!proxyBodyImages('<img src="https://example.org/unknown.png">').includes('srcset='));
  const web = proxyBodyImages(html);
  assert.doesNotMatch(web, /srcset=/);
  assert.match(web, / src="[^"]+mode=reading/);
  assert.match(web, / data-full-sig="[0-9a-f]{16}"/);
  assert.doesNotMatch(web, /mode=full/);
  assert.match(web, /loading="lazy"/);
  assert.match(web, /width="800" height="400"/);
  assert.doesNotMatch(web, /sizes="auto\b/, "body images must use their loaded ratio even if publisher dimensions are wrong");
  assert.doesNotMatch(proxyBodyImages(html, true), /srcset=/);
});

test("image HTTP responses serve signed URLs, reject tampering and unsigned modes before fetching and do not vary on Accept", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { signature } = await import("@aihot/backend/media/imgproxy");
  const app = Fastify();
  registerMedia(app);
  const url = `${base}/http-image`;
  const exp = String(Math.ceil(Date.now() / 1000) + 3600);
  const params = new URLSearchParams({ u: url, mode: "card", exp, sig: signature(url, "card", exp) });
  const before = imageHits;
  const invalidParams = new URLSearchParams(params);
  invalidParams.set("sig", "invalid");
  const invalid = await app.inject({ url: `/api/img-proxy?${invalidParams}` });
  assert.equal(invalid.statusCode, 403);
  assert.equal(imageHits, before);
  const first = await app.inject({ url: `/api/img-proxy?${params}`, headers: { accept: "image/avif" } });
  const second = await app.inject({ url: `/api/img-proxy?${params}`, headers: { accept: "image/webp" } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.headers["content-type"], "image/webp");
  assert.deepEqual(first.rawPayload, second.rawPayload);
  // An address without a mode (signed before 2026-09-30, all expired by 2026-11-01) is no longer read.
  const modeless = new URLSearchParams({ u: url, exp, sig: signature(url, "default", exp) });
  assert.notEqual((await app.inject({ url: `/api/img-proxy?${modeless}` })).statusCode, 200);
  // URLs carry 16 hex digits; a wrong one is refused.
  const { proxiedImage } = await import("@aihot/backend/media/imgproxy");
  const short = proxiedImage(url, "card")!;
  assert.match(short, /&sig=[0-9a-f]{16}$/);
  assert.equal((await app.inject({ url: short })).statusCode, 200);
  assert.equal((await app.inject({ url: short.replace(/sig=(.)/, (_m, c: string) => `sig=${c === "0" ? "1" : "0"}`) })).statusCode, 403);
  await app.close();
});

// Protocol failures to prevent: validators bypassing signature checks, unchanged bytes downloading
// again, old validators hiding an animation replacement, and failures outliving a short signature.
test("image validators save unchanged bytes only after signature verification", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { signature } = await import("@aihot/backend/media/imgproxy");
  const app = Fastify();
  registerMedia(app);
  const url = `${base}/validated-image`;
  const exp = String(Math.ceil(Date.now() / 1000) + 3600);
  const params = new URLSearchParams({ u: url, mode: "card", exp, sig: signature(url, "card", exp) });
  try {
    const first = await app.inject({ url: `/api/img-proxy?${params}` });
    const etag = String(first.headers.etag);
    assert.match(etag, /^"[a-f0-9]+"$/, "image validators describe the actual representation with a strong tag");
    assert.equal(first.headers["x-img-proxy-sig"], "valid");
    const before = imageHits;
    for (const validator of [etag, `"different", W/${etag}`, "*"]) {
      const cached = await app.inject({ url: `/api/img-proxy?${params}`, headers: { "if-none-match": validator } });
      assert.equal(cached.statusCode, 304);
      assert.equal(cached.rawPayload.length, 0);
      assert.equal(cached.headers.etag, etag);
      assert.match(String(cached.headers["cache-control"]), /max-age=/);
    }
    const changed = await app.inject({ url: `/api/img-proxy?${params}`, headers: { "if-none-match": '"different"' } });
    assert.equal(changed.statusCode, 200);
    assert.deepEqual(changed.rawPayload, first.rawPayload);
    assert.equal(imageHits, before, "conditional reads keep using the prepared disk image");
    const bad = new URLSearchParams(params);
    bad.set("sig", "0".repeat(16));
    const expired = new URLSearchParams(params);
    expired.set("exp", String(Math.floor(Date.now() / 1000) - 1));
    expired.set("sig", signature(url, "card", expired.get("exp")!));
    for (const query of [bad, expired]) {
      const denied = await app.inject({ url: `/api/img-proxy?${query}`, headers: { "if-none-match": etag } });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.headers["cache-control"], "no-store");
      assert.equal(denied.headers.etag, undefined);
      assert.equal(denied.headers["x-img-proxy-sig"], query === expired ? "expired" : "invalid");
    }
    const head = await app.inject({ method: "HEAD", url: `/api/img-proxy?${params}`, headers: { "if-none-match": etag } });
    assert.equal(head.statusCode, 304, "a HEAD revalidates like a GET");
    assert.equal(head.headers.etag, etag);
    assert.equal(head.headers["x-accel-expires"], undefined);
    const missing = await app.inject({ url: "/api/img-proxy", headers: { "if-none-match": "*" } });
    assert.equal(missing.statusCode, 400, "a malformed query is the client's error");
    assert.equal(missing.headers["x-img-proxy-sig"], "invalid");
  } finally {
    await app.close();
  }
});

test("an image server's own errors are cached for at most a minute and never beyond the signature", async (t) => {
  const { default: Fastify } = await import("fastify");
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { signature } = await import("@aihot/backend/media/imgproxy");
  const app = Fastify();
  registerMedia(app);
  try {
    for (const lifetime of [3600, 15]) {
      const url = `${base}/fail`;
      const signedAt = Date.now();
      const exp = String(Math.floor(signedAt / 1000) + lifetime);
      const params = new URLSearchParams({ u: url, mode: "card", exp, sig: signature(url, "card", exp) });
      // A VM's wall clock steps back when it syncs with its host (on the CI VMs by as much as 0.4 s): this read runs a second behind the signing.
      const readAt = signedAt - 1000;
      t.mock.timers.enable({ apis: ["Date"], now: readAt });
      const failed = await app.inject({ url: `/api/img-proxy?${params}`, headers: { "if-none-match": "*" } });
      t.mock.timers.reset();
      assert.equal(failed.statusCode, 502);
      const cache = String(failed.headers["cache-control"]);
      const seconds = Number(/(?:^|[, ])max-age=(\d+)/.exec(cache)?.[1]);
      assert.equal(seconds, Math.min(60, Number(exp) - Math.floor(readAt / 1000)), cache);
      assert.match(cache, new RegExp(`s-maxage=${seconds}(?:,|$)`));
      assert.equal(failed.headers.etag, undefined);
    }
  } finally {
    await app.close();
  }
});

// 10-20..10-28 three images openai.com refused (403) were fetched about 1,400 times each and missing goodfire.com
// ones 4,352 times: a minute's failure is asked for again by every edge node, every minute readers open the page.
test("an image its server refuses or no longer has is not asked for again for hours", async (t) => {
  const { default: Fastify } = await import("fastify");
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { signature } = await import("@aihot/backend/media/imgproxy");
  const app = Fastify();
  registerMedia(app);
  try {
    for (const url of [`${base}/gone`, `${base}/refused`]) {
      const exp = String(Math.floor(Date.now() / 1000) + 86400);
      const request = `/api/img-proxy?${new URLSearchParams({ u: url, mode: "card", exp, sig: signature(url, "card", exp) })}`;
      const hits = refusalHits;
      const failed = await app.inject({ url: request });
      assert.equal(failed.statusCode, 502);
      assert.match(String(failed.headers["cache-control"]), /(?:^|[, ])max-age=21600, s-maxage=21600$/);
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 3600_000 });
      assert.equal((await app.inject({ url: request })).statusCode, 502);
      t.mock.timers.reset();
      assert.equal(refusalHits, hits + 1, `${url} is fetched once within the hours its failure is kept`);
    }
  } finally {
    t.mock.timers.reset();
    await app.close();
  }
});

test("pending animations expire at caches, then publish the prepared disk rendition without refetching", async (t) => {
  const { default: Fastify } = await import("fastify");
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { signature } = await import("@aihot/backend/media/imgproxy");
  const { convertAnimated } = await import("@aihot/backend/media/images");
  const { getBoss, QUEUES } = await import("@aihot/backend/jobs/queue");
  const { sql } = await import("@aihot/backend/db");
  const app = Fastify();
  registerMedia(app);
  const url = `${base}/anim.gif`;
  const signedAt = Date.now();
  const exp = String(Math.ceil(signedAt / 1000) + 3600);
  const params = new URLSearchParams({ u: url, mode: "thumb", exp, sig: signature(url, "thumb", exp) });
  const first = await app.inject({ url: `/api/img-proxy?${params}` });
  assert.equal(first.statusCode, 200);
  assert.match(String(first.headers["cache-control"]), /max-age=60, s-maxage=60/);
  assert.match(String(first.headers.etag), /^"[a-f0-9]+"$/);
  const again = await app.inject({ url: `/api/img-proxy?${params}` });
  assert.deepEqual(again.rawPayload, first.rawPayload);
  const fetched = animationHits;
  const boss = await getBoss();
  // Queued a minute ago: the fetch's `start_after <= now` holds even when the VM's clock steps back (on the CI VMs by as much as 0.4 s).
  await sql`UPDATE pgboss.job SET start_after = start_after - interval '1 minute' WHERE name = ${QUEUES.prepareMedia} AND state = 'created'`;
  const jobs = await boss.fetch<{ url: string; mode: string }>(QUEUES.prepareMedia);
  assert.equal(jobs.length, 1);
  const saved = await convertAnimated(jobs[0]!.data.url, jobs[0]!.data.mode);
  assert.ok(saved > 0);
  await boss.complete(QUEUES.prepareMedia, jobs[0]!.id);
  // A VM's wall clock steps back when it syncs with its host (on the CI VMs by as much as 0.4 s): this read runs a second behind the signing.
  const readAt = signedAt - 1000;
  t.mock.timers.enable({ apis: ["Date"], now: readAt });
  const prepared = await app.inject({ url: `/api/img-proxy?${params}`, headers: { "if-none-match": String(first.headers.etag) } });
  t.mock.timers.reset();
  assert.equal(prepared.statusCode, 200, "a cached original GIF must not hide the prepared WebP");
  assert.notEqual(prepared.headers.etag, first.headers.etag);
  assert.equal(prepared.headers["content-type"], "image/webp");
  const ttl = Number(/s-maxage=(\d+)/.exec(String(prepared.headers["cache-control"]))?.[1]);
  assert.equal(ttl, Number(exp) - Math.floor(readAt / 1000), "the signature's remaining hour at the reader's clock, never the seven-day ceiling");
  assert.equal(animationHits, fetched);
  const unchanged = await produceImage(`${base}/tiny.gif`, "thumb");
  assert.equal(unchanged.pendingAnimation, true);
  assert.equal(await convertAnimated(`${base}/tiny.gif`, "thumb"), 0);
  const ready = await produceImage(`${base}/tiny.gif`, "thumb");
  assert.deepEqual(ready.body, tinyGif);
  assert.equal(ready.pendingAnimation, undefined);
  const unsupported = await produceImage(`${base}/over-budget.gif`, "thumb");
  assert.deepEqual(unsupported.body, overBudgetGif);
  assert.equal(unsupported.pendingAnimation, undefined);
  assert.equal(await convertAnimated(`${base}/over-budget.gif`, "thumb"), 0);
  await app.close();
});

test("binary-labelled real images work, but binary-labelled error pages still return 502", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { proxiedImage } = await import("@aihot/backend/media/imgproxy");
  const app = Fastify();
  registerMedia(app);
  const image = await app.inject({ url: proxiedImage(`${base}/binary-image`, "card")! });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/webp");
  assert.equal((await sharp(image.rawPayload).metadata()).width, 336);
  const error = await app.inject({ url: proxiedImage(`${base}/binary-error`, "card")! });
  assert.equal(error.statusCode, 502);
  // Arduino's CDN serves real JPEG/PNG bytes under this generic MIME alias. A 200 HTML error with
  // the same label must still fail; accepting the label alone would disguise an upstream failure.
  const alias = await app.inject({ url: proxiedImage(`${base}/binary-alias`, "card")! });
  assert.equal(alias.statusCode, 200);
  assert.equal((await sharp(alias.rawPayload).metadata()).width, 336);
  const aliasError = await app.inject({ url: proxiedImage(`${base}/binary-alias-error`, "card")! });
  assert.equal(aliasError.statusCode, 502);
  await app.close();
});

test("tracking pixels are omitted from old and new bodies without removing article illustrations", async () => {
  const { sanitizeBody } = await import("@aihot/backend/content/sanitize");
  const { proxyBodyImages } = await import("@aihot/backend/media/imgproxy");
  const html = '<p>Article</p><img src="https://ids4.ad.gt/api/v1/ip_match?id=example"><img src="https://secure.adnxs.com/getuid?x=1"><img src="https://example.org/pixel" width="1" height="1"><img src="https://example.org/chart.png" width="800" height="400">';
  for (const body of [sanitizeBody(html), proxyBodyImages(html)]) {
    assert.doesNotMatch(body, /ids4|adnxs|example.org\/pixel/);
    assert.equal((body.match(/<img\b/g) ?? []).length, 1);
    assert.match(decodeURIComponent(body), /example.org\/chart.png/);
  }
});

// Extracted Markdown can mislabel a video page as an image. New ingestion and previously saved
// bodies must both stop signing those pages; RSS, Markdown, responsive media and posters must agree.
// Real thumbnails/icons and existing video links or video elements must keep working.
test("video pages mislabeled as images are excluded across ingestion and public image outputs", async () => {
  const { sanitizeBody } = await import("@aihot/backend/content/sanitize");
  const { markdownBody, bodyToMarkdown } = await import("@aihot/backend/content/markdown");
  const { proxiedImage, proxiedImageSet, proxyBodyImages } = await import("@aihot/backend/media/imgproxy");
  const pages = [
    "https://www.youtube.com/watch?v=example&t=1",
    "https://youtube.com/shorts/example",
    "https://m.youtube.com/watch?v=example",
    "https://www.youtube.com/shorts/example",
  ];
  const pictures = [
    "https://www.youtube.com/s/desktop/example/favicon_32x32.png",
    "https://i.ytimg.com/vi/example/hqdefault.jpg",
    "https://example.org/watch.png",
    "https://youtube.com.example.org/watch?v=example",
  ];
  const stored = [...pages, ...pictures].map((url) => `<img src="${url.replaceAll("&", "&amp;")}" alt="Image" width="800" height="400">`).join("");
  const markdown = [...pages, ...pictures].map((url) => `![Image](${url})`).join("\n\n");
  for (const html of [sanitizeBody(stored), markdownBody(markdown, "https://example.org/post"), proxyBodyImages(stored), proxyBodyImages(stored, true)]) {
    assert.equal((html.match(/<img\b/g) ?? []).length, pictures.length, html);
    assert.doesNotMatch(decodeURIComponent(html), /https:\/\/(?:www\.|m\.)?youtube\.com\/(?:watch|shorts)/);
  }
  assert.equal((bodyToMarkdown(stored).match(/!\[/g) ?? []).length, pictures.length);
  for (const url of pages) {
    assert.equal(proxiedImage(url, "full"), null);
    assert.equal(proxiedImageSet(url, "hero"), null);
    assert.equal(xView({ zh_text: null, x_post: { media: [{ url }] } }, true)!.media.length, 0);
  }
  for (const url of pictures) {
    assert.ok(proxiedImage(url, "full"));
    assert.ok(proxiedImageSet(url, "hero"));
  }
  const video = `<a href="${pages[0]!.replaceAll("&", "&amp;")}">Watch video</a><video src="https://example.org/video.mp4" poster="${pictures[1]}"></video>`;
  for (const html of [sanitizeBody(video), proxyBodyImages(video), proxyBodyImages(video, true)]) {
    assert.match(html, /<a href="https:\/\/www\.youtube\.com\/watch/);
    assert.match(html, /<video src="https:\/\/example\.org\/video\.mp4"/);
    assert.match(decodeURIComponent(html), /i\.ytimg\.com\/vi\/example\/hqdefault\.jpg/);
  }
  assert.doesNotMatch(proxyBodyImages(`<video src="https://example.org/video.mp4" poster="${pages[1]}"></video>`), /poster=/);
});

// Failure modes of the AVIF variant: a browser that picked the AVIF source getting a broken image (a
// <picture> does not fall back to the img when its source fails), an AVIF less sharp than the image it
// replaces or not worth the switch, a variant usable without its rendition's signature, animations
// losing their own preparation, and AVIF reaching RSS readers or images without a responsive set.
test("an AVIF variant is signed as its rendition and serves that rendition until a sharper-or-equal, smaller AVIF is prepared", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { signature } = await import("@aihot/backend/media/imgproxy");
  const { convertAvif } = await import("@aihot/backend/media/images");
  const { QUEUES } = await import("@aihot/backend/jobs/queue");
  const { sql } = await import("@aihot/backend/db");
  const app = Fastify();
  registerMedia(app);
  const url = `${base}/photo.jpg`;
  const exp = String(Math.ceil(Date.now() / 1000) + 3600);
  const sig = signature(url, "thumb", exp);
  const variant = `/api/img-proxy?${new URLSearchParams({ u: url, mode: "thumb-avif", exp, sig })}`;
  assert.equal((await app.inject({ url: `/api/img-proxy?${new URLSearchParams({ u: url, mode: "card-avif", exp, sig })}` })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/img-proxy?${new URLSearchParams({ u: url, mode: "avatar-avif", exp, sig: signature(url, "avatar", exp) })}` })).statusCode, 403,
    "only the renditions the pages offer as AVIF have a variant");
  const rendition = await app.inject({ url: `/api/img-proxy?${new URLSearchParams({ u: url, mode: "thumb", exp, sig })}` });
  assert.equal(rendition.headers["content-type"], "image/jpeg");
  const waiting = await app.inject({ url: variant });
  assert.equal(waiting.statusCode, 200);
  assert.equal(waiting.headers["content-type"], "image/jpeg");
  assert.deepEqual(waiting.rawPayload, rendition.rawPayload);
  assert.match(String(waiting.headers["cache-control"]), /max-age=60, s-maxage=60/);
  const queued = await sql<{ data: Record<string, string> }[]>`SELECT data FROM pgboss.job WHERE name = ${QUEUES.prepareMedia} AND state = 'created'`;
  assert.deepEqual(queued.map((j) => j.data).filter((d) => d.url === url), [{ url, mode: "thumb", format: "avif" }]);

  assert.ok(await convertAvif(url, "thumb") > 0);
  const prepared = await app.inject({ url: variant });
  assert.equal(prepared.headers["content-type"], "image/avif");
  assert.ok(prepared.rawPayload.length < rendition.rawPayload.length * 0.9);
  assert.doesNotMatch(String(prepared.headers["cache-control"]), /max-age=60,/);
  assert.notEqual(prepared.headers.etag, waiting.headers.etag);
  const [avif, jpeg] = await Promise.all([sharp(prepared.rawPayload).metadata(), sharp(rendition.rawPayload).metadata()]);
  assert.deepEqual([avif.width, avif.height], [jpeg.width, jpeg.height]);
  assert.equal(await convertAvif(url, "thumb"), 0, "a prepared variant is not encoded again");

  // A flat image is already a few bytes as WebP: the variant keeps it, for good, without queueing again.
  const flat = `${base}/flat-image`;
  const flatVariant = `/api/img-proxy?${new URLSearchParams({ u: flat, mode: "card-avif", exp, sig: signature(flat, "card", exp) })}`;
  assert.equal(await convertAvif(flat, "card"), 0);
  const kept = await app.inject({ url: flatVariant });
  assert.equal(kept.headers["content-type"], "image/webp");
  assert.doesNotMatch(String(kept.headers["cache-control"]), /max-age=60,/);
  const requeued = await sql`SELECT 1 FROM pgboss.job WHERE name = ${QUEUES.prepareMedia} AND state = 'created' AND data->>'url' = ${flat}`;
  assert.equal(requeued.length, 0);

  // An animation's variant is the animation, prepared the way animations are.
  const gif = `${base}/tiny.gif`;
  const gifVariant = await app.inject({ url: `/api/img-proxy?${new URLSearchParams({ u: gif, mode: "thumb-avif", exp, sig: signature(gif, "thumb", exp) })}` });
  assert.deepEqual(gifVariant.rawPayload, tinyGif);
  assert.equal(await convertAvif(gif, "thumb"), 0);
  await app.close();
});

test("body GIFs load only their poster until playback; full feeds and publisher links keep their target", async () => {
  const { proxyBodyImages, verifyProxyRequest } = await import("@aihot/backend/media/imgproxy");
  const { load } = await import("cheerio");
  const html = '<figure><picture><img src="https://example.org/demo.gif" alt="Demo" width="800"></picture><figcaption>Caption</figcaption></figure>';
  const page = load(proxyBodyImages(html));
  const player = page("video");
  assert.equal(player.attr("preload"), "none");
  assert.equal(player.attr("aria-label"), "Demo");
  assert.equal(page("figcaption").text(), "Caption");
  for (const [attr, mode] of [["poster", "reading"], ["src", "gif-video"]] as const) {
    const query = Object.fromEntries(new URL(player.attr(attr)!, "https://example.test").searchParams);
    assert.equal(query.mode, mode);
    assert.equal(verifyProxyRequest(query).ok, true);
  }
  const full = new URL(player.attr("poster")!, "https://example.test");
  full.searchParams.set("mode", "full");
  full.searchParams.set("sig", player.attr("data-full-sig")!);
  assert.equal(verifyProxyRequest(Object.fromEntries(full.searchParams)).ok, true);
  assert.match(proxyBodyImages(html, true), /<img[^>]+mode=full/);
  assert.doesNotMatch(proxyBodyImages(html, true), /<video|data-full-sig|mode=reading/);
  const link = proxyBodyImages('<a href="https://example.org/visit"><img src="https://example.org/demo.gif"></a>');
  assert.match(link, /<a href="https:\/\/example.org\/visit"><img/);
  assert.doesNotMatch(link, /<video/);
});

test("the reading image is a still, and a prepared GIF movie supports the player's byte range", async () => {
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { signature, GIF_VIDEO_MODE } = await import("@aihot/backend/media/imgproxy");
  const { default: Fastify } = await import("fastify");
  const url = base + "/anim.gif";
  const preview = await produceImage(url, "reading");
  const meta = await sharp(preview.body).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.pages ?? 1, 1);
  const exp = String(Math.ceil(Date.now() / 1000) + 3600);
  const address = "/api/img-proxy?" + new URLSearchParams({ u: url, exp, mode: GIF_VIDEO_MODE, sig: signature(url, GIF_VIDEO_MODE, exp) });
  const app = Fastify();
  registerMedia(app);
  try {
    const pending = await app.inject({ url: address });
    assert.equal(pending.statusCode, 202);
    assert.equal(pending.headers["cache-control"], "no-store");
    const file = createHash("sha256").update(GIF_VIDEO_MODE + "|" + url).digest("hex");
    const folder = path.join(dir, "imgcache", file.slice(0, 2));
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, file), Buffer.from("prepared video bytes"));
    const range = await app.inject({ url: address, headers: { range: "bytes=0-1" } });
    assert.equal(range.statusCode, 206);
    assert.equal(range.headers["content-type"], "video/mp4");
    assert.equal(range.body, "pr");
  } finally {
    await app.close();
  }
});


test("a large GIF can become a reading preview while its raw bytes remain over the public image limit", async () => {
  const url = base + "/large-source.gif";
  await assert.rejects(produceImage(url, "full"), /Response too large/);
  const preview = await produceImage(url, "reading");
  assert.equal(preview.type, "image/webp");
  assert.ok(preview.body.length < 30_000);
  assert.equal(preview.pendingVideo, true);
  await assert.rejects(produceImage(url, "full"), /Response too large/);
});
