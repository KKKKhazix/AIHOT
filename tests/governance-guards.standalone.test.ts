// Pure unit tests and negative counterexamples for shared contracts and architecture guards.
import assert from "node:assert/strict";
import { test } from "node:test";
import { etagMatches } from "@aihot/contracts/http-policy";
import { monthRange } from "@aihot/contracts/time";
import { topLevelCalls } from "./source-checks.ts";
import { clockViolations } from "./test-clock.ts";
import { fileRouterLinkViolations } from "./web-text.ts";

test("monthRange handles boundary years, leap years, and invalid months without throwing", () => {
  assert.deepEqual(monthRange("0001-12"), { start: "0001-12-01", end: "0001-12-31" });
  assert.deepEqual(monthRange("9999-12"), { start: "9999-12-01", end: "9999-12-31" });
  assert.deepEqual(monthRange("0004-02"), { start: "0004-02-01", end: "0004-02-29" });
  assert.deepEqual(monthRange("2024-02"), { start: "2024-02-01", end: "2024-02-29" });
  assert.deepEqual(monthRange("2026-02"), { start: "2026-02-01", end: "2026-02-28" });
  assert.equal(monthRange("2026-00"), null);
  assert.equal(monthRange("2026-13"), null);
  assert.equal(monthRange("2026-9"), null);
});

test("etagMatches obeys RFC 9110 quote boundaries and wildcard rules", () => {
  assert.equal(etagMatches("*", 'W/"abc"'), true);
  assert.equal(etagMatches(" * ", '"abc"'), true);
  assert.equal(etagMatches('"other,*,tag"', 'W/"abc"'), false);
  assert.equal(etagMatches('"other,*,tag"', '"other,*,tag"'), true);
  assert.equal(etagMatches('W/"a", *', 'W/"b"'), false);
  assert.equal(etagMatches('W/"a,b", "c"', '"a,b"'), true);
  assert.equal(etagMatches('W/"a,b", "c"', 'W/"c"'), true);
  assert.equal(etagMatches('W/"a,b", "c"', '"b"'), false);
  assert.equal(etagMatches(undefined, '"a"'), false);
});

test("architecture guards catch real counterexamples", () => {
  // Top-level call guard catches eager evaluation like `const collecting = collectionEnabled();`.
  assert.equal(topLevelCalls("const collecting = collectionEnabled();", "collectionEnabled").length, 1);
  assert.equal(
    topLevelCalls("const list = [{ when: collectionEnabled }, { when: () => collectionEnabled() && ok() }];", "collectionEnabled").length,
    0,
  );

  // Clock guard still flags now() even when an earlier interpolation contains unbalanced parens in strings/templates.
  const insertHead = "await sql`INSERT INTO items (title, published_at)";
  const nestedSql = [
    `${insertHead} VALUES (\${\`foo (bar\`}, now())\`;`,
    `${insertHead} VALUES (\${"foo )bar"}, \${new Date()})\`;`,
  ].join("\n");
  assert.equal(clockViolations(nestedSql).length, 2);

  // Router link guard catches named imports, namespace JSX/member access, and destructuring, while allowing safe hooks.
  assert.equal(fileRouterLinkViolations('import { Link } from "react-router";').length, 1);
  assert.equal(fileRouterLinkViolations('import * as Router from "react-router"; export const A = () => <Router.Link to="/x" />;').length, 1);
  assert.equal(fileRouterLinkViolations('import * as Router from "react-router"; export const go = () => Router.useNavigate();').length, 1);
  assert.equal(fileRouterLinkViolations('import * as Router from "react-router"; const { NavLink } = Router;').length, 1);
  assert.equal(fileRouterLinkViolations('import * as Router from "react-router"; export const loc = () => Router.useLocation();').length, 0);
});
