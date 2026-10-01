// Opens the site's main pages and machine exits and checks each answers: the whole-site check after a
// deploy, and CI's check of the built site on an empty database.
//   node scripts/smoke.ts [--base http://localhost:3000]
import { SITE } from "@aihot/industry/site";
import { FEATURES } from "@aihot/industry/features";

const at = process.argv.indexOf("--base");
const base = (at > 0 ? process.argv[at + 1] : process.env.SITE_URL) ?? "http://localhost:3000";

const PAGES = ["/", "/all", "/hot", "/daily", "/daily/archive", "/topics", "/starred", "/agent", "/about", "/changelog", "/feedback", "/terms", "/privacy", "/more", "/admin/login"];
const MACHINE: Array<[path: string, type: RegExp]> = [
  ["/api/health", /json/],
  ["/api/v1/items", /json/],
  ["/api/v1/hot-topics", /json/],
  ["/api/v1/selected/snapshot", /json/],
  ["/feed.xml", /xml/],
  ["/feed/all.xml", /xml/],
  ["/llms.txt", /text\/plain/],
  ["/robots.txt", /text\/plain/],
  ["/sitemap.xml", /xml/],
  ["/manifest.webmanifest", /manifest/],
  ["/openapi-v1.json", /json/],
  ["/og/site.png", /image\/png/],
  ["/icon.png", /image\/png/],
  ["/favicon.ico", /icon/],
];
// The leaderboard pages answer 503 until the first round is published (a fresh site computes it when
// the worker starts; with collection off there is nothing to compute).
const LEADERBOARD = FEATURES.leaderboard ? ["/leaderboard", "/leaderboard/rules", "/leaderboard/sources"] : [];
PAGES.push(...LEADERBOARD);
if (FEATURES.codexResetMonitor) PAGES.push("/codex-reset");

let failed = 0;
async function check(path: string, expect: (res: Response, body: string) => string | null) {
  try {
    const res = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    const body = res.headers.get("content-type")?.startsWith("image/") ? "" : await res.text();
    if (res.status === 503 && LEADERBOARD.includes(path)) {
      console.log(`– ${path}  no leaderboard round published yet`);
      return;
    }
    const problem = res.status !== 200 ? `HTTP ${res.status}` : expect(res, body);
    console.log(`${problem ? "✗" : "✓"} ${path}${problem ? `  ${problem}` : ""}`);
    if (problem) failed += 1;
  } catch (error) {
    console.log(`✗ ${path}  ${String(error)}`);
    failed += 1;
  }
}

// Pages write the name as HTML text: a name such as "MyF&B" appears as "MyF&amp;B".
const htmlName = SITE.name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
for (const path of PAGES) await check(path, (_res, body) => (body.includes(SITE.name) || body.includes(htmlName) ? null : `the page does not name ${SITE.name}`));
for (const [path, type] of MACHINE) await check(path, (res) => (type.test(res.headers.get("content-type") ?? "") ? null : `content-type ${res.headers.get("content-type")}`));
// MCP: the handshake answers with the site's server name.
const mcp = await fetch(`${base}/api/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } }),
}).then((r) => r.text()).catch((e) => String(e));
const mcpOk = mcp.includes(`"name":"${SITE.mcpPrefix}"`);
console.log(`${mcpOk ? "✓" : "✗"} /api/mcp initialize${mcpOk ? "" : `  ${mcp.slice(0, 200)}`}`);
if (!mcpOk) failed += 1;

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
