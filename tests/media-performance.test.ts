import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { SITE } from "@aihot/site";

const dir = await mkdtemp(path.join(tmpdir(), "aihot-media-test-"));
process.env.AIHOT_DATA_DIR = dir;
process.env.ALLOW_PRIVATE_NETWORK_FETCH = "true";
process.env.MODEL_CALLS_ENABLED = "false";
const { produceImage } = await import("@aihot/backend/media/images");
const { renderOg } = await import("@aihot/backend/media/og");
const { renderPoster } = await import("@aihot/backend/media/poster");
const { xView } = await import("@aihot/backend/publication/items");

let imageHits = 0;
let failureHits = 0;
let animationHits = 0;
const png = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#176b75" } }).png().toBuffer();
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
  if (req.url === "/anim.gif") { animationHits++; res.writeHead(200, { "content-type": "image/gif" }); return res.end(animatedGif); }
  if (req.url === "/tiny.gif") { res.writeHead(200, { "content-type": "image/gif" }); return res.end(tinyGif); }
  if (req.url === "/over-budget.gif") { res.writeHead(200, { "content-type": "image/gif" }); return res.end(overBudgetGif); }
  if (req.url === "/binary-image") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(png); }
  if (req.url === "/binary-alias") { res.writeHead(200, { "content-type": "binary/octet-stream" }); return res.end(png); }
  if (req.url === "/binary-alias-error") { res.writeHead(200, { "content-type": "binary/octet-stream" }); return res.end("<html>Not an image</html>"); }
  if (req.url === "/binary-error") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end("<html>Image not found</html>"); }
  if (req.url === "/fail") { failureHits++; res.writeHead(502); return res.end(); }
  imageHits++;
  await new Promise((resolve) => setTimeout(resolve, 60));
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

test("site media exposes responsive previews and full lightboxes while RSS retains thumb images", () => {
  const row = { zh_text: null, x_post: { media: [{ url: "https://example.org/1.png" }, { url: "https://example.org/2.png", poster: "https://example.org/poster.png" }] } };
  assert.ok(xView(row, true)!.media.every((m) => m.url.includes("mode=card") && m.fullUrl?.includes("mode=full")));
  assert.ok(xView(row, true)!.media[1]!.poster!.includes("mode=card"));
  assert.ok(xView(row)!.media.every((m) => m.url.includes("mode=thumb") && m.fullUrl === undefined));
  const detail = xView(row, false, true)!.media;
  assert.ok(detail.every((m) => m.url.includes("mode=full") && m.srcSet?.includes("mode=thumb")));
  for (const media of detail.filter((m) => !m.poster)) {
    // Opening a picture already displayed at full resolution must reuse its browser cache entry.
    assert.equal(media.srcSet!.split(", ").at(-1), `${media.poster ?? media.url} 1600w`);
  }
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

test("successive responsive candidates reuse the completed original download", async () => {
  const before = imageHits;
  const url = `${base}/successive`;
  const small = await produceImage(url, "image-336");
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
    assert.equal(verifyProxyRequest({ ...query, mode: "image-1600" }, now).ok, false);
  }
  const html = '<p><img src="https://example.org/image.png?a=1&amp;b=2" width="800" height="400"></p>';
  assert.ok(!proxyBodyImages('<img src="https://example.org/small.png" width="160" height="80">').includes('srcset='));
  assert.ok(!proxyBodyImages('<img src="https://example.org/unknown.png">').includes('srcset='));
  const web = proxyBodyImages(html);
  assert.match(web, /srcset="[^"]+mode=thumb/);
  const tag = web.match(/<img\b[^>]+>/)![0];
  const bodySource = tag.match(/\bsrc="([^"]+)"/)![1];
  assert.equal(tag.match(/\bsrcset="([^"]+)"/)![1]!.split(", ").at(-1), `${bodySource} 1600w`);
  assert.match(web, /loading="lazy"/);
  assert.match(web, /width="800" height="400"/);
  assert.doesNotMatch(web, /sizes="auto\b/, "body images must use their loaded ratio even if publisher dimensions are wrong");
  assert.doesNotMatch(proxyBodyImages(html, true), /srcset=/);
});

test("image HTTP responses keep earlier URLs valid, reject tampering before fetching and do not vary on Accept", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { signature } = await import("@aihot/backend/media/imgproxy");
  const app = Fastify();
  registerMedia(app);
  const url = `${base}/http-image`;
  const exp = String(Math.ceil(Date.now() / 1000) + 3600);
  const params = new URLSearchParams({ u: url, mode: "image-336", exp, sig: signature(url, "image-336", exp) });
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
  const old = new URLSearchParams({ u: url, exp, sig: signature(url, "default", exp) });
  assert.equal((await app.inject({ url: `/api/img-proxy?${old}` })).statusCode, 200);
  // Current URLs carry the first 16 hex digits; a wrong short signature is refused like a long one.
  const { proxiedImage } = await import("@aihot/backend/media/imgproxy");
  const short = proxiedImage(url, "image-336")!;
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
  const params = new URLSearchParams({ u: url, mode: "image-336", exp, sig: signature(url, "image-336", exp) });
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
    expired.set("sig", signature(url, "image-336", expired.get("exp")!));
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

test("image failures are cached for at most a minute and never beyond the signature", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { signature } = await import("@aihot/backend/media/imgproxy");
  const app = Fastify();
  registerMedia(app);
  try {
    for (const lifetime of [3600, 15]) {
      const url = `${base}/fail`;
      const exp = String(Math.floor(Date.now() / 1000) + lifetime);
      const params = new URLSearchParams({ u: url, mode: "image-336", exp, sig: signature(url, "image-336", exp) });
      const failed = await app.inject({ url: `/api/img-proxy?${params}`, headers: { "if-none-match": "*" } });
      assert.equal(failed.statusCode, 502);
      const cache = String(failed.headers["cache-control"]);
      const seconds = Number(/(?:^|[, ])max-age=(\d+)/.exec(cache)?.[1]);
      assert.ok(seconds > 0 && seconds <= Math.min(60, lifetime), cache);
      assert.match(cache, new RegExp(`s-maxage=${seconds}(?:,|$)`));
      assert.equal(failed.headers.etag, undefined);
    }
  } finally {
    await app.close();
  }
});

test("pending animations expire at caches, then publish the prepared disk rendition without refetching", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { signature } = await import("@aihot/backend/media/imgproxy");
  const { convertAnimated } = await import("@aihot/backend/media/images");
  const { getBoss, QUEUES } = await import("@aihot/backend/jobs/queue");
  const app = Fastify();
  registerMedia(app);
  const url = `${base}/anim.gif`;
  const exp = String(Math.ceil(Date.now() / 1000) + 3600);
  const params = new URLSearchParams({ u: url, mode: "image-720", exp, sig: signature(url, "image-720", exp) });
  const first = await app.inject({ url: `/api/img-proxy?${params}` });
  assert.equal(first.statusCode, 200);
  assert.match(String(first.headers["cache-control"]), /max-age=60, s-maxage=60/);
  assert.match(String(first.headers.etag), /^"[a-f0-9]+"$/);
  const again = await app.inject({ url: `/api/img-proxy?${params}` });
  assert.deepEqual(again.rawPayload, first.rawPayload);
  const fetched = animationHits;
  const boss = await getBoss();
  const jobs = await boss.fetch<{ url: string; mode: string }>(QUEUES.prepareMedia);
  assert.equal(jobs.length, 1);
  const saved = await convertAnimated(jobs[0]!.data.url, jobs[0]!.data.mode);
  assert.ok(saved > 0);
  await boss.complete(QUEUES.prepareMedia, jobs[0]!.id);
  const prepared = await app.inject({ url: `/api/img-proxy?${params}`, headers: { "if-none-match": String(first.headers.etag) } });
  assert.equal(prepared.statusCode, 200, "a cached original GIF must not hide the prepared WebP");
  assert.notEqual(prepared.headers.etag, first.headers.etag);
  assert.equal(prepared.headers["content-type"], "image/webp");
  const ttl = Number(/s-maxage=(\d+)/.exec(String(prepared.headers["cache-control"]))?.[1]);
  assert.ok(ttl > 3500 && ttl <= 3601, "the signature's remaining hour, never the seven-day ceiling");
  assert.equal(animationHits, fetched);
  const unchanged = await produceImage(`${base}/tiny.gif`, "image-720");
  assert.equal(unchanged.pendingAnimation, true);
  assert.equal(await convertAnimated(`${base}/tiny.gif`, "image-720"), 0);
  const ready = await produceImage(`${base}/tiny.gif`, "image-720");
  assert.deepEqual(ready.body, tinyGif);
  assert.equal(ready.pendingAnimation, undefined);
  const unsupported = await produceImage(`${base}/over-budget.gif`, "image-720");
  assert.deepEqual(unsupported.body, overBudgetGif);
  assert.equal(unsupported.pendingAnimation, undefined);
  assert.equal(await convertAnimated(`${base}/over-budget.gif`, "image-720"), 0);
  await app.close();
});

test("binary-labelled real images work, but binary-labelled error pages still return 502", async () => {
  const { default: Fastify } = await import("fastify");
  const { registerMedia } = await import("../apps/api/src/routes/media.ts");
  const { proxiedImage } = await import("@aihot/backend/media/imgproxy");
  const app = Fastify();
  registerMedia(app);
  const image = await app.inject({ url: proxiedImage(`${base}/binary-image`, "image-336")! });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/webp");
  assert.equal((await sharp(image.rawPayload).metadata()).width, 336);
  const error = await app.inject({ url: proxiedImage(`${base}/binary-error`, "image-336")! });
  assert.equal(error.statusCode, 502);
  // Arduino's CDN serves real JPEG/PNG bytes under this generic MIME alias. A 200 HTML error with
  // the same label must still fail; accepting the label alone would disguise an upstream failure.
  const alias = await app.inject({ url: proxiedImage(`${base}/binary-alias`, "image-336")! });
  assert.equal(alias.statusCode, 200);
  assert.equal((await sharp(alias.rawPayload).metadata()).width, 336);
  const aliasError = await app.inject({ url: proxiedImage(`${base}/binary-alias-error`, "image-336")! });
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
    assert.equal(proxiedImageSet(url, "body"), null);
    assert.equal(xView({ zh_text: null, x_post: { media: [{ url }] } }, true)!.media.length, 0);
  }
  for (const url of pictures) {
    assert.ok(proxiedImage(url, "full"));
    assert.ok(proxiedImageSet(url, "body"));
  }
  const video = `<a href="${pages[0]!.replaceAll("&", "&amp;")}">Watch video</a><video src="https://example.org/video.mp4" poster="${pictures[1]}"></video>`;
  for (const html of [sanitizeBody(video), proxyBodyImages(video), proxyBodyImages(video, true)]) {
    assert.match(html, /<a href="https:\/\/www\.youtube\.com\/watch/);
    assert.match(html, /<video src="https:\/\/example\.org\/video\.mp4"/);
    assert.match(decodeURIComponent(html), /i\.ytimg\.com\/vi\/example\/hqdefault\.jpg/);
  }
  assert.doesNotMatch(proxyBodyImages(`<video src="https://example.org/video.mp4" poster="${pages[1]}"></video>`), /poster=/);
});
