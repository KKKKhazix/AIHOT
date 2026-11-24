// Google News link decoding: only entries a source asked for are decoded (decodeGoogleNewsLinks),
// the cursor's cache answers repeat listings without new requests, failures keep the Google URL and
// stop after repeated attempts, and one run decodes at most its cap.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveGoogleNewsLinks, type GoogleNewsFetcher } from "@aihot/backend/sources/gnews";

const GOOGLE_URL = (id: string) => `https://news.google.com/rss/articles/${id}?oc=5`;
const PAGE = (ts: number) => `<html><c-wiz data-n-a-ts="${ts}" data-n-a-sg="SIG${ts}"></c-wiz></html>`;

const source = (decodeGoogleNewsLinks = true) =>
  ({ id: "gnews-test", kind: "rss", config: { decodeGoogleNewsLinks, feedUrl: "https://news.google.com/rss/search?q=x" } }) as never;

/** A fetcher over recorded answers: GET serves the article page, POST the batchexecute response. */
function stubbed(decodeAnswer: string, calls: string[] = []): GoogleNewsFetcher {
  return async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (init.method === "GET") return { status: 200, text: PAGE(Date.parse("2026-11-24T00:00:00Z") / 1000) };
    // batchexecute embeds its payload with escaped quotes: [\"garturlres\",\"https://...\"].
    return { status: 200, text: `)]}'\n\n[[[\\"garturlres\\",\\"${decodeAnswer}\\",null]]]` };
  };
}

const entry = (id: string) => ({ url: GOOGLE_URL(id), title: `Entry ${id}` });

test("an entry is decoded to its publisher URL and the mapping is cached in the cursor", async () => {
  const calls: string[] = [];
  const cursor: Record<string, unknown> = {};
  const [out] = await resolveGoogleNewsLinks([entry("A")], source(), cursor, stubbed("https://www.example.com/article-a", calls));
  assert.equal(out.url, "https://www.example.com/article-a");
  assert.deepEqual(calls.map((c) => c.split("/")[2]), ["news.google.com", "news.google.com"]);
  const gnews = cursor.gnews as { cache: Record<string, string> };
  assert.equal(gnews.cache[GOOGLE_URL("A")], "https://www.example.com/article-a");

  // A later listing of the same entry is answered from the cache: no requests at all.
  const cursor2: Record<string, unknown> = { gnews: structuredClone(gnews) };
  const calls2: string[] = [];
  const [out2] = await resolveGoogleNewsLinks([entry("A")], source(), cursor2, stubbed("", calls2));
  assert.equal(out2.url, "https://www.example.com/article-a");
  assert.equal(calls2.length, 0);
});

test("without the flag, or for non-Google URLs, nothing is fetched or changed", async () => {
  const calls: string[] = [];
  const plain = [{ url: "https://www.example.com/post", title: "Post" }];
  const out = await resolveGoogleNewsLinks(plain, source(false), {}, stubbed("https://x", calls));
  assert.equal(out[0].url, "https://www.example.com/post");
  assert.equal(calls.length, 0);
  const out2 = await resolveGoogleNewsLinks(plain, source(true), {}, stubbed("https://x", calls));
  assert.equal(out2[0].url, "https://www.example.com/post");
  assert.equal(calls.length, 0);
});

test("a failing decode keeps the Google URL and stops retrying after repeated attempts", async () => {
  const calls: string[] = [];
  const failing: GoogleNewsFetcher = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (init.method === "GET") return { status: 200, text: PAGE(1) };
    return { status: 200, text: ")]}'\n\n[]" }; // batchexecute answers without a URL
  };
  const cursor: Record<string, unknown> = {};
  for (let run = 0; run < 4; run++) {
    const [out] = await resolveGoogleNewsLinks([entry("B")], source(), cursor, failing);
    assert.equal(out.url, GOOGLE_URL("B"), "the entry stays at its Google URL");
  }
  const failures = (cursor.gnews as { failures: Record<string, number> }).failures;
  assert.equal(failures[GOOGLE_URL("B")], 3, "three failed runs are remembered");
  const before = calls.length;
  await resolveGoogleNewsLinks([entry("B")], source(), cursor, failing);
  assert.equal(calls.length, before, "a fourth run does not retry the entry again");
});

test("one run decodes at most its cap; the rest keep their Google URL for a later run", async () => {
  const entries = Array.from({ length: 45 }, (_, i) => entry(`C${i}`));
  const decoded: string[] = [];
  const fetcher: GoogleNewsFetcher = async (url, init) => {
    if (init.method === "GET") return { status: 200, text: PAGE(2) };
    decoded.push(url);
    return { status: 200, text: `)]}'\n\n[[[\\"garturlres\\",\\"https://www.example.com/${decoded.length}\\",null]]]` };
  };
  const out = await resolveGoogleNewsLinks(entries, source(), {}, fetcher);
  assert.equal(decoded.length, 40, "the run's decode cap");
  assert.equal(out.filter((c) => c.url.startsWith("https://www.example.com/")).length, 40);
  assert.equal(out.filter((c) => c.url.includes("news.google.com/rss/articles/")).length, 5, "the over-cap entries stay as listed");
});
