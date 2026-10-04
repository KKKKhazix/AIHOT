import { motion } from "motion/react";
import { SITE } from "@aihot/site";
import { NavLink, Outlet, useLocation, useNavigation, type ShouldRevalidateFunction } from "react-router";
import type { Route } from "./+types/layout";
import { RingMark } from "@aihot/site/brand/Logo.tsx";
import { NavigationProgress } from "../../components/shell/Chrome";
import type { AdminMe, AdminNavCounts } from "@aihot/contracts/admin";
import { Toaster } from "../../features/admin/toast";
import { adminGet } from "../../lib/admin.server";
import type { AdminNavEntry } from "../../modules";
import { webModules } from "../../site-modules";

export async function loader({ request }: Route.LoaderArgs) {
  const [me, counts] = await Promise.all([adminGet<AdminMe>(request, "/api/admin/me"), adminGet<AdminNavCounts>(request, "/api/admin/nav-counts").catch((): AdminNavCounts => ({}))]);
  return { me, counts };
}

// Counts follow every navigation and command; the identity does not change.
export const shouldRevalidate: ShouldRevalidateFunction = () => true;

export const meta: Route.MetaFunction = () => [{ title: `${SITE.name} 后台` }, { name: "robots", content: "noindex, nofollow" }];

export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });

/** The admin navigation: the modules' own groups first, their content entries after 信源. */
const nav = (): Array<{ group: string; items: AdminNavEntry[] }> => [
  ...webModules().flatMap((m) => m.admin?.groups ?? []),
  {
    group: "内容",
    items: [
      { to: "/admin/content", label: "内容诊断" },
      { to: "/admin/sources", label: "信源", count: "sources", tone: "bad" },
      ...webModules().flatMap((m) => m.admin?.content ?? []),
      { to: "/admin/feedback", label: "反馈", count: "feedback", tone: "accent" },
    ],
  },
  {
    group: "系统",
    items: [
      { to: "/admin/runs", label: "运行", count: "runs", tone: "bad" },
      { to: "/admin/models", label: "模型与评测" },
      { to: "/admin/selectbench", label: "SelectBench" },
      { to: "/admin/settings", label: "设置" },
      { to: "/admin/audit", label: "审计记录" },
    ],
  },
];

function NavItem({ to, label, count, tone }: { to: string; label: string; count?: number; tone?: "bad" | "accent" }) {
  return (
    <NavLink to={to} prefetch="intent" className="group relative block">
      {({ isActive }) => (
        <span className={`relative flex items-center justify-between rounded-control px-3 py-[7px] text-[13.5px] transition-colors ${isActive ? "font-medium text-ink" : "text-ink-3 hover:text-ink"}`}>
          {isActive && <motion.span layoutId="admin-nav" className="absolute inset-0 rounded-control bg-surface shadow-sm ring-1 ring-line" transition={{ type: "spring", stiffness: 520, damping: 38 }} />}
          <span className="relative">{label}</span>
          {!!count && (
            <span className={`num relative min-w-5 rounded-full px-1.5 text-center text-[11px] font-semibold leading-5 ${tone === "bad" ? "bg-hot text-white" : "bg-accent-soft text-accent"}`}>{count}</span>
          )}
        </span>
      )}
    </NavLink>
  );
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  const { me, counts } = loaderData;
  const navigation = useNavigation();
  const location = useLocation();
  const groups = nav();
  const flat = groups.flatMap((g) => g.items);
  return (
    <div className="flex min-h-dvh bg-bg">
      <NavigationProgress active={navigation.state === "loading"} />
      <aside className="sticky top-0 hidden h-dvh w-[216px] shrink-0 flex-col border-r border-line bg-bg-sunk/50 px-3 py-4 lg:flex">
        <a href="/" className="mb-5 flex items-center gap-2 px-2">
          <RingMark className="size-6 text-accent" />
          <span className="text-[15px] font-semibold tracking-tight text-ink">{`${SITE.name} 后台`}</span>
        </a>
        <nav className="scrollbar-thin flex-1 space-y-4 overflow-y-auto">
          {groups.map((g) => (
            <div key={g.group}>
              <div className="mb-1 px-3 text-[11.5px] font-medium tracking-wide text-ink-4">{g.group}</div>
              <div className="space-y-0.5">
                {g.items.map((i) => (
                  <NavItem key={i.to} to={i.to} label={i.label} count={i.count ? counts[i.count] : undefined} tone={i.tone} />
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="mt-3 border-t border-line px-2 pt-3 text-[12.5px] text-ink-3">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">{me.name}</span>
            {me.dev && <span className="rounded bg-amber/15 px-1.5 text-[11px] font-medium text-amber">开发</span>}
          </div>
          <form method="post" action="/api/auth/logout" className="mt-1.5">
            <button type="submit" className="text-ink-4 hover:text-ink-2">退出登录</button>
          </form>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur lg:hidden">
          <div className="flex items-center gap-2 px-4 pt-3">
            <RingMark className="size-5 text-accent" />
            <span className="text-[14px] font-semibold text-ink">{`${SITE.name} 后台`}</span>
            {me.dev && <span className="rounded bg-amber/15 px-1.5 text-[11px] font-medium text-amber">开发</span>}
          </div>
          <nav className="no-scrollbar flex gap-1 overflow-x-auto px-3 py-2">
            {flat.map((i) => {
              const active = location.pathname === i.to || location.pathname.startsWith(`${i.to}/`);
              const n = i.count ? counts[i.count] : 0;
              return (
                <NavLink key={i.to} to={i.to} className={`shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-[13px] ${active ? "bg-ink text-bg" : "text-ink-3"}`}>
                  {i.label}
                  {!!n && <span className="num ml-1 text-[11px] opacity-70">{n}</span>}
                </NavLink>
              );
            })}
          </nav>
        </div>
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  );
}
