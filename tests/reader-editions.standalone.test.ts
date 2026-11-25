import assert from "node:assert/strict";
import test from "node:test";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { ENGLISH } from "@aihot/contracts/english";
import { inLanguage } from "@aihot/contracts/i18n";
import { READER_PAGES, localizePath } from "@aihot/contracts/reader-pages";
import { MODULES } from "@aihot/site/modules";
import routes from "../apps/web/app/routes.ts";

test("both editions reach the same route module and links agree with the registered pages", () => {
  const files = new Map<string, string>();
  function visit(entries: RouteConfigEntry[]) {
    for (const entry of entries) {
      if (entry.index || entry.path) files.set(entry.index ? "/" : "/" + entry.path, entry.file);
      if (entry.children) visit(entry.children);
    }
  }
  visit(routes);
  const expected = new Set<string>();
  function check(path: string, bilingual: boolean) {
    const english = inLanguage(path, "en");
    const example = path.replace(/:[^/]+/g, "sample");
    assert.ok(files.has(path), path);
    if (ENGLISH && bilingual) {
      expected.add(english);
      assert.equal(files.get(english), files.get(path), english + " must use the same component as " + path);
      assert.equal(localizePath(example + "?q=one#result", "en"), inLanguage(example, "en") + "?q=one#result");
    } else {
      assert.equal(files.has(english), false, english + " has no published edition");
    }
  }
  for (const p of READER_PAGES) check("/" + p.path, !p.chineseOnly);
  for (const m of MODULES) {
    for (const p of (m.pages ?? []).flatMap(p => "layout" in p ? p.pages : [p])) {
      const path = "/" + (p.admin ? "admin/" : p.gray ? "preview/" : "") + p.path;
      check(path, !!(m.en || p.en) && !p.admin && !p.gray);
    }
  }
  assert.deepEqual(new Set([...files.keys()].filter(p => p === "/en" || p.startsWith("/en/"))), expected);
  for (const path of ["/terms", "/privacy", "/api/health", "//other.example/all", "https://other.example/all"]) {
    assert.equal(localizePath(path, "en"), path);
  }
});
