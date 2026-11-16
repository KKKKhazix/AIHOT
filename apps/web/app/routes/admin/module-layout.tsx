// The back office's shell for the modules' admin pages (ModulePage.admin): its own sidebar, listing those pages by
// their nav names, instead of the site's. Only the admins a site module names get past its loader; everyone else
// gets the site's 404. The engine's own admin pages keep their layout (layout.tsx).
import { data, Link, NavLink, Outlet, useNavigation } from "react-router";
import { SITE } from "@aihot/site";
import { RingMark } from "@aihot/site/brand/Logo.tsx";
import { MODULES } from "@aihot/site/modules";
import { NavigationProgress } from "../../components/shell/Chrome";
import { adminPageAccess, GRAY_HEADERS } from "../../lib/admin.server";

/** The sidebar: every admin page without parameters in its address, in the order the site lists its modules. */
const NAV = MODULES.flatMap((m) => (m.pages ?? []).flatMap((p) => ("layout" in p || !p.admin || p.path.includes(":") ? [] : [{ to: `/admin/${p.path}`, label: p.nav ?? p.path }])));

// Plain types, not the generated ones: a site without admin pages (the open-source edition) has no such route.
export async function loader({ request }: { request: Request }) {
  return data(await adminPageAccess(request), { headers: GRAY_HEADERS });
}

export const headers = () => ({ ...GRAY_HEADERS, "X-Robots-Tag": "noindex, nofollow" });

export const meta = () => [{ title: `${SITE.name} 后台` }, { name: "robots", content: "noindex, nofollow" }];

export default function ModuleAdminLayout({ loaderData }: { loaderData: { name: string } }) {
  const navigation = useNavigation();
  const brand = (
    <span className="flex items-center gap-2">
      <RingMark className="size-6 text-accent" />
      <span className="text-[15px] font-semibold tracking-tight text-ink">{`${SITE.name} 后台`}</span>
    </span>
  );
  const back = `回到 ${SITE.name}`;
  return (
    <div className="flex min-h-dvh bg-bg">
      <NavigationProgress active={navigation.state === "loading"} />
      <aside className="sticky top-0 hidden h-dvh w-[216px] shrink-0 flex-col border-r border-line bg-bg-sunk/50 px-3 py-4 lg:flex">
        <div className="mb-5 px-2">{brand}</div>
        <nav className="scrollbar-thin flex-1 space-y-0.5 overflow-y-auto">
          {NAV.map((i) => (
            <NavLink key={i.to} to={i.to}
              className={({ isActive }) => `block rounded-control px-3 py-[7px] text-[13.5px] transition-colors ${isActive ? "bg-surface font-medium text-ink shadow-sm ring-1 ring-line" : "text-ink-3 hover:text-ink"}`}>
              {i.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-3 border-t border-line px-2 pt-3 text-[12.5px]">
          <div className="truncate text-ink-3">{loaderData.name}</div>
          <Link to="/" className="mt-1.5 inline-block text-ink-4 transition-colors hover:text-ink-2">{back}</Link>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur lg:hidden">
          <div className="flex items-center gap-2 pl-4 pr-2">
            {brand}
            <Link to="/" className="ml-auto inline-flex min-h-11 items-center px-2 text-[13px] text-ink-3">{back}</Link>
          </div>
          {NAV.length > 1 && (
            <nav className="scrollbar-none flex gap-1 overflow-x-auto px-3 pb-2">
              {NAV.map((i) => (
                <NavLink key={i.to} to={i.to}
                  className={({ isActive }) => `inline-flex min-h-9 shrink-0 items-center whitespace-nowrap rounded-full px-3 text-[13px] ${isActive ? "bg-ink text-bg" : "text-ink-3"}`}>
                  {i.label}
                </NavLink>
              ))}
            </nav>
          )}
        </div>
        <main className="min-w-0 flex-1 px-4 pb-10 pt-4 lg:px-8 lg:pt-6">
          <div className="mx-auto max-w-[1180px]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
