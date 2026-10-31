// Observed failures: a paid Reader response is HTTP 200 for a missing or challenged target;
// stripping its title hides the error and a long navigation/footer passes the body length check.
// Native soft errors can also pollute detail metadata. Real articles about errors and benign
// Reader warnings must remain usable; rejecting a paid page must retain and reuse its receipt.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { config } from "@aihot/backend/config";
import { closeDb, sql } from "@aihot/backend/db";
import { extractArticleBody, extractFromUrl, isSignInRedirect, isSignInUrl, readable } from "@aihot/backend/content/extract";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { jinaRead } from "@aihot/backend/providers/jina";
import { fetchDetail, fetchWebList } from "@aihot/backend/sources/web-list";

const T = tag();
const sourceId = `error-page-${T}`;
const navigation = "Tech Reviews Science Entertainment AI Policy Subscribe Contact Privacy Terms of Use. ".repeat(8);
const missing = "We couldn't find the page you were looking for. This is either because: There is an error in the URL entered into your web browser. Please check the URL and try again. The page you are looking for has been moved or deleted. You can return to our homepage by clicking here, or you can try searching for the content you are seeking.";
const challenge = "example.org Performing security verification This website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot. Verification successful. Waiting for example.org to respond. Performance and Security by Cloudflare.";
const prose = "A real report explains why a service returned 404 and how CAPTCHA verification affects its users. ".repeat(8);
const html = (title: string, text: string) => `<html><head><title>${title}</title><meta name="description" content="False description"></head><body><article><h1>${title}</h1><p>${text}</p><a href="/news/post">Navigation item</a></article></body></html>`;
const signInPage = html("Sign in to Example", "Sign in to your account. Enter your email address and password to continue. ".repeat(6));
const autofill = "A real report explains how password managers fill a sign-in form and why autofill is safer than typing. ".repeat(4);
let readerHits = 0;
const readerPages: Record<string, string> = {
  missing: `Title: 404 Not Found | Example\n\nMarkdown Content:\n${navigation}\n404 Page Not Found\nThat page does not exist.\n${navigation}`,
  status: `Title: Build software better, together\nWarning: Target URL returned error 404: Not Found\n\nMarkdown Content:\n${navigation}`,
  captcha: `Title: example.org\nWarning: This page maybe requiring CAPTCHA, please make sure you are authorized to access this page.\n\nMarkdown Content:\n${challenge}`,
  html: html("Just a moment...", challenge),
  valid: `Title: Why 404 errors happen\nWarning: This is a cached snapshot of the original page.\n\nMarkdown Content:\n${prose}\n\nWarning: Target URL returned error 404: Not Found`,
};
const server = http.createServer((req, res) => {
  // The redirect has to answer before the default headers: a source URL the site sends to its sign-in form.
  if (req.url === "/redirect") { res.writeHead(302, { location: "/login" }); return void res.end(); }
  if (req.url === "/brand/register") { res.writeHead(301, { location: "/brand/register/" }); return void res.end(); }
  res.writeHead(200, { "content-type": req.url?.startsWith("/reader/") ? "text/plain" : "text/html", "x-usage-tokens": "100" });
  if (req.url?.startsWith("/reader/")) {
    readerHits++;
    return void res.end(readerPages[req.url.split("/").at(-1)!] ?? readerPages.missing);
  }
  // The form itself is long enough to be mistaken for a body by the length and density checks.
  if (req.url === "/article") return void res.end(html("Password autofill in browsers", autofill));
  if (req.url === "/login") return void res.end(signInPage);
  if (req.url === "/brand/register/") return void res.end(html("The certified products register", prose));
  if (req.url === "/listing") return void res.end(`<html><body>
    <article><a href="/article">Password autofill in browsers</a></article>
    <nav><a href="/login">Log in</a><a href="/signup">Sign up</a></nav>
  </body></html>`);
  res.end(html("404 Not Found | Example", navigation));
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.JINA_API_KEY = "test-key";
process.env.JINA_BASE_URL = `${base}/reader`;
config.allowPrivateNetworkFetch = true;
before(async () => {
  await sql`INSERT INTO sources(id,name,kind) VALUES (${sourceId},'Error page regression','rss')`;
  await sql`UPDATE budgets SET per_minute=1000,per_hour=1000,per_day=1000 WHERE service='jina'`;
});
after(async () => { server.close(); await closeDb(); });

test("soft 404 and security interstitials cannot become native article bodies", () => {
  for (const page of [html("404 Not Found | Example", navigation), html("Just a moment...", challenge),
    html("Example", missing), html("Example", challenge), html("Example", navigation).replace("<h1>Example</h1>", "<h1>Page Not Found</h1>")]) {
    assert.equal(readable(page, `${base}/missing`), null);
  }
  assert.ok(readable(html("Why 404 errors happen", prose), `${base}/valid`)?.text.includes(prose.trim()));
});

test("a missing target stays unconfirmed and its paid response is reused, not bought again", async () => {
  const excerpt = "The publisher's actual feed description remains available.";
  const { articleId } = await upsertMaterial({ sourceId, url: `${base}/${T}/missing`, title: "A real headline", excerpt, via: "fetch" });
  const hits = readerHits;
  assert.equal(await extractArticleBody(articleId), "unconfirmed");
  assert.equal(await extractArticleBody(articleId), "unconfirmed");
  assert.equal(readerHits, hits + 1);
  const [article] = await sql`SELECT body_status,body_text,body_html,excerpt FROM articles WHERE id=${articleId}`;
  assert.deepEqual({ ...article }, { body_status: "unconfirmed", body_text: null, body_html: null, excerpt });
  const [receipt] = await sql`SELECT status,attempts,usage FROM receipts WHERE subject=${`article:${articleId}`}`;
  assert.equal(receipt!.status, "received");
  assert.equal(receipt!.attempts, 1);
  assert.equal(receipt!.usage.tokens, 100);
});

test("Reader target failures and rendered HTML challenges reject before listing or detail parsing", async () => {
  for (const name of ["missing", "status", "captcha", "html"]) {
    await assert.rejects(jinaRead(`https://example.org/${T}/${name}`, { purpose: "source_detail", subject: sourceId, ...(name === "html" ? { format: "html" as const } : {}) }), /unavailable page/i);
  }
  const valid = await jinaRead(`https://example.org/${T}/valid`, { purpose: "source_detail", subject: sourceId });
  assert.ok(valid.markdown.includes(prose), "only the Reader header is protocol metadata; warnings quoted in an article are prose");
});

test("a native soft error supplies neither listing items nor detail title, date or summary", async () => {
  const source = { id: sourceId, config: { url: `${base}/missing`, parseMode: "html", itemSelector: "article", titleSelector: "h1", detail: { titleSelector: "h1", summarySelector: 'meta[name="description"]' } } } as never;
  await assert.rejects(fetchWebList(source), /unavailable page/i);
  await assert.rejects(fetchDetail(`${base}/missing`, source, { title: true, date: true, summary: true, body: true }), /unavailable page/i);
});

// A redirect to the site's sign-in form is an error page too: the form's length and density pass the
// body checks, and a source that builds arxiv.org URLs once stored HuggingFace's login page as the
// article body (its navigation changed between fetches, so it became 26 revisions of a title "220").
test("a redirect to a sign-in form cannot become the body", async () => {
  // Without the redirect check this page is accepted: it is long enough and reads like an article.
  assert.ok(readable(signInPage, `${base}/login`), "the sign-in form passes the body checks — that is the trap");
  assert.equal(await extractFromUrl(`${base}/redirect`, `article:${T}:signin`, {}, { paidFallback: false }), null);
  // An article that merely mentions signing in and passwords is still an article.
  const got = await extractFromUrl(`${base}/article`, `article:${T}:autofill`, {}, { paidFallback: false });
  assert.ok(got?.text.includes("password managers"), "text about sign-in forms is not a sign-in redirect");
  // A page that is itself on such a path and only gains a trailing slash was not sent to sign in.
  const registry = await extractFromUrl(`${base}/brand/register`, `article:${T}:registry`, {}, { paidFallback: false });
  assert.ok(registry?.text.includes("real report"), "a redirect between two addresses of the same page is no sign-in redirect");
  // A listing's detail read is the other way in: the sign-in form supplies no title, date, summary or body.
  const source = { id: sourceId, config: { url: `${base}/listing`, parseMode: "html" } } as never;
  await assert.rejects(fetchDetail(`${base}/redirect`, source, { title: true, date: true, summary: true, body: true }), /unavailable page/i);
});

// A listing's navigation links to the site's sign-in and registration pages; they are not posts.
test("a listing's sign-in links are not articles", async () => {
  const source = { id: sourceId, config: { url: `${base}/listing`, parseMode: "html", itemSelector: "a[href]", linkSelector: "a[href]" } } as never;
  const candidates = await fetchWebList(source);
  assert.deepEqual(candidates.map((c) => c.url).sort(), [`${base}/article`]);
});

// Devise answers /users/sign_in and WordPress /wp-login.php: real sign-in forms that were not on the path
// list, so a redirect to one passed the length test and became the body (KKKKhazix/AIHOT#275).
test("the sign-in paths common sites use are sign-in paths; pages that only carry an auth word are not", () => {
  for (const path of ["/users/sign_in", "/users/sign_up", "/wp-login.php", "/member/login.php", "/en/register.html", "/login"]) {
    assert.equal(isSignInUrl(`https://x.com${path}`), true, path);
  }
  assert.equal(isSignInRedirect("https://x.com/post/1", "https://x.com/users/sign_in"), true);
  assert.equal(isSignInRedirect("https://x.com/post/1", "https://x.com/wp-login.php?redirect_to=https%3A%2F%2Fx.com%2Fpost%2F1"), true);
  assert.equal(isSignInRedirect("https://x.com/post/1", "https://x.com/member/login.php"), true);
  for (const path of ["/authorized-retailer", "/authors", "/sso-products", "/login.company"]) assert.equal(isSignInUrl(`https://x.com${path}`), false, path);
  assert.equal(isSignInRedirect("https://x.com/users/sign_in", "https://x.com/users/sign_in/"), false);
});
