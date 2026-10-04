// A module's marks and pictures (ServerModule.staticAssets) are served from the repository's assets/,
// under the address its pages name. Failures: the socket is registered but nothing is served; a name
// with a slash, a dot-dot or an upper-case letter reaches the filesystem; or the web server does not
// send the address to the api process, so a page's picture is a 404 in production.
import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeDb } from "@aihot/backend/db";
import { installModules } from "@aihot/backend/modules";
import { buildApp } from "../apps/api/src/app.ts";

// site/brand holds the site's own marks; one of them stands in for a picture a module ships in assets/.
// (assets/ currently ships only the og fonts, so there is no svg or png of its own to point at.)
const DIR = "../site/brand";
const FILE = "logo.svg";

// Installed before the app is built, as each process does when it starts (apps/api/src/main.ts).
installModules([{ name: "test", staticAssets: { "/test-marks": DIR } }]);

const app = await buildApp();
after(async () => { await app.close(); await closeDb(); });

test("a module's declared assets are served from assets/ with the file's own type and a long cache", async () => {
  const res = await app.inject({ method: "GET", url: `/test-marks/${FILE}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/svg+xml");
  assert.equal(res.headers["cache-control"], "public, max-age=604800");
  assert.ok(res.rawPayload.length > 0);
});

test("only flat lower-case svg and png names are served, so a name cannot leave its directory", async () => {
  for (const name of [
    "UPPER.svg",           // the rule allows lower-case only
    "two_words.svg",       // and no underscore
    "noto-sans-sc-400.ttf", // nor another extension
    "..%2f..%2fpackage.json",
    "%2e%2e%2fpackage.json",
    "nested%2Ffile.svg",   // an encoded slash stays one path segment, but is not a legal name
  ]) {
    const res = await app.inject({ method: "GET", url: `/test-marks/${name}` });
    assert.equal(res.statusCode, 404, name);
  }
});

test("an address no module declares has no route at all", async () => {
  const res = await app.inject({ method: "GET", url: `/test-marks-undeclared/${FILE}` });
  assert.equal(res.statusCode, 404);
});
