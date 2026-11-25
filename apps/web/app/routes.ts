import { type RouteConfig, type RouteConfigEntry, index, layout, route } from "@react-router/dev/routes";
import type { ModulePage } from "@aihot/contracts/modules";
import { MODULES } from "@aihot/site/modules";
import { englishPages, READER_PAGES } from "@aihot/contracts/reader-pages";

/** A module's route module, from the app directory. */
const file = (module: string, path: string) => `../../../modules/${module}/${path}`;
const page = (module: string, p: ModulePage) => route(p.gray ? `preview/${p.path}` : p.admin ? `admin/${p.path}` : p.path, file(module, p.file), p.id ? { id: p.id } : {});

/** The site's modules' pages, after the engine's; admin pages go into the back office's shell. */
const modulePages: RouteConfigEntry[] = MODULES.flatMap((m) =>
  (m.pages ?? []).filter((p) => "layout" in p || !p.admin)
    .map((p) => ("layout" in p ? layout(file(m.name, p.layout), p.id ? { id: p.id } : {}, p.pages.map((c) => page(m.name, c))) : page(m.name, p))),
);
const adminPages: RouteConfigEntry[] = MODULES.flatMap((m) => (m.pages ?? []).flatMap((p) => ("layout" in p || !p.admin ? [] : [page(m.name, p)])));

/**
 * The pages with an English edition again under /en, using the same route modules. The address
 * decides the language. A layout keeps its English children.
 */
function inEnglish(entries: RouteConfigEntry[]): RouteConfigEntry[] {
  const english = new Set(englishPages());
  const visit = (list: RouteConfigEntry[]): RouteConfigEntry[] => list.flatMap((e): RouteConfigEntry[] => {
    if (e.path === undefined && !e.index && e.children) {
      const children = visit(e.children);
      return children.length ? [{ ...e, id: `en-${e.id ?? e.file}`, children }] : [];
    }
    if (!english.has(e.index ? "/" : `/${e.path}`)) return [];
    return [{ ...e, index: undefined, path: e.index ? "en" : `en/${e.path}`, id: `en-${e.id ?? e.file}` }];
  });
  return visit(entries);
}

const PAGES: RouteConfigEntry[] = [
  ...READER_PAGES.map((p) => p.path ? route(p.path, p.file, p.id ? { id: p.id } : {}) : index(p.file)),
  ...modulePages,
];

export default [
  ...PAGES,
  ...inEnglish(PAGES),
  // The modules' admin pages (ModulePage.admin), for the admins a site module names, in their own back-office shell.
  ...(adminPages.length ? [layout("routes/admin/module-layout.tsx", { id: "module-admin-layout" }, adminPages)] : []),
  route("admin/login", "routes/admin-login.tsx"),
  // A site without admin pages (null ADMIN settings) answers 404 here (the layout); signing in serves every site.
  layout("routes/admin/layout.tsx", { id: "admin-layout" }, [
    route("admin", "routes/admin/index.tsx"),
    route("admin/content", "routes/admin/content.tsx"),
    route("admin/content/:id", "routes/admin/content-item.tsx"),
    route("admin/sources", "routes/admin/sources.tsx"),
    route("admin/sources/new", "routes/admin/source-new.tsx"),
    route("admin/sources/:id", "routes/admin/source.tsx"),
    route("admin/feedback", "routes/admin/feedback.tsx"),
    route("admin/runs", "routes/admin/runs.tsx"),
    route("admin/models", "routes/admin/models.tsx"),
    route("admin/selectbench", "routes/admin/selectbench.tsx"),
    route("admin/selectbench/:runId", "routes/admin/selectbench-run.tsx"),
    route("admin/settings", "routes/admin/settings.tsx"),
    route("admin/audit", "routes/admin/audit.tsx"),
  ]),
] satisfies RouteConfig;
