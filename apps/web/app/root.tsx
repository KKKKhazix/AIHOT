import {
  isRouteErrorResponse, Link, Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData, useLocation, useNavigation, useRouteError, useRouteLoaderData,
  type ShouldRevalidateFunction,
} from "react-router";
import type { SiteMeta } from "@aihot/contracts/site";
import { SITE } from "@aihot/industry/site";
import { RingMark } from "@aihot/industry/brand/Logo.tsx";
import { useEffect, useState, type ReactNode } from "react";
import type { Route } from "./+types/root";
import "./app.css";
import { Sidebar } from "./components/shell/Sidebar";
import { TabBar } from "./components/shell/TabBar";
import { PullToRefresh } from "./components/shell/PullToRefresh";
import { usePageTransition } from "./components/shell/transitions";
import { SearchOverlay } from "./features/search/SearchOverlay";
import { BackToTop, NavigationProgress } from "./components/shell/Chrome";
import { buttonClass } from "./components/ui/Controls";
import { rememberPage, THEME_BOOT_SCRIPT, useThemeSync } from "./lib/local-state";
import { apiGet } from "./lib/api.server";
import { useHydratedFlag } from "./lib/hydration";
import { titled } from "./lib/seo";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "any" },
  { rel: "icon", type: "image/png", href: "/icon.png" },
  { rel: "apple-touch-icon", href: "/apple-icon.png" },
  { rel: "manifest", href: "/manifest.webmanifest" },
  { rel: "alternate", type: "application/rss+xml", title: `${SITE.name} — 精选`, href: "/feed.xml" },
];

/** The release rendering this document: once a newer one is deployed, a render error reloads the page (entry.client). */
export async function loader({ request }: Route.LoaderArgs) {
  const release = process.env.AIHOT_RELEASE ?? null;
  try {
    const meta = await apiGet<SiteMeta>("/api/site/meta", {
      signal: request.signal,
    });
    return { ...meta, release };
  } catch {
    return { changelogVersion: null, release };
  }
}

export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export function Layout({ children }: { children: React.ReactNode }) {
  const site = useRouteLoaderData<typeof loader>("root");
  const [documentRelease] = useState(site?.release ?? null);
  return (
    <html lang={SITE.locale} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        {documentRelease && <meta name="aihot-release" content={documentRelease} />}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#faf9f6" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#13191c" />
        <meta name="apple-mobile-web-app-title" content={SITE.name} />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration getKey={(location) => location.key} />
        <Scripts />
      </body>
    </html>
  );
}

/** Only a page nobody matched falls back to this; every page names itself. */
export function meta({ error }: Route.MetaArgs) {
  if (!error) return [];
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return [{ title: titled(notFound ? "页面不存在" : "暂时无法加载") }, { name: "robots", content: "noindex" }];
}

/** Sidebar, main column and phone tab bar around a page (or an error). */
function SiteShell({ changelogVersion, children }: { changelogVersion: string | null; children: ReactNode }) {
  const navigation = useNavigation();
  // The phone search and pull-to-refresh are client-side, mounted once the page is interactive.
  const [interactive, setInteractive] = useState(false);
  useEffect(() => setInteractive(true), []);
  return (
    <div className="flex min-h-dvh">
      <NavigationProgress active={navigation.state === "loading"} />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-control focus:bg-surface focus:px-3 focus:py-2">
        跳到正文
      </a>
      <Sidebar changelogVersion={changelogVersion} />
      {/* Phone shell (≤ 960px): each page's top bar (PhoneBar), one centred column, the tab bar below.
          Desktop: the page fills the main area up to the list width (--page-max-wide), centred beyond it. */}
      <main id="main" className="min-w-0 flex-1 pb-[calc(72px+env(safe-area-inset-bottom))] lg:px-7 lg:pb-[72px] lg:pt-6">
        <div className="mx-auto w-full max-w-[640px] pl-[var(--gutter-l)] pr-[var(--gutter-r)] lg:max-w-[var(--page-max-wide)] lg:px-0">
          {children}
        </div>
      </main>
      <TabBar changelogVersion={changelogVersion} />
      {interactive && <SearchOverlay />}
      {interactive && <PullToRefresh />}
      <BackToTop />
    </div>
  );
}

export default function App() {
  const meta = useLoaderData<typeof loader>();
  useHydratedFlag();
  useThemeSync();
  const { pathname, search } = useLocation();
  useEffect(() => rememberPage(pathname + search), [pathname, search]);
  usePageTransition();
  // iOS Safari only shows :active (pressed) styles once the document listens for touches.
  useEffect(() => {
    const noop = () => {};
    document.addEventListener("touchstart", noop, { passive: true });
    return () => document.removeEventListener("touchstart", noop);
  }, []);
  // The admin has its own chrome.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return <Outlet />;
  return (
    <>
      <SiteShell changelogVersion={meta.changelogVersion}>
        <Outlet />
      </SiteShell>
    </>
  );
}

export function ErrorBoundary() {
  useThemeSync();
  const error = useRouteError();
  const site = useRouteLoaderData<typeof loader>("root");
  const { pathname, search, hash } = useLocation();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const notFound = status === 404;
  const body = (
    <div className="flex min-h-[70vh] items-center justify-center px-2 py-16">
      <div className="max-w-sm text-center">
        <RingMark className="mx-auto mb-5 size-10 text-accent" />
        <div className="mono text-[12px] text-ink-4">{status}</div>
        <h1 className="mt-1.5 text-[20px] font-bold text-ink">{notFound ? "这里没有内容" : "暂时无法加载"}</h1>
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-3">
          {notFound ? "你访问的页面不存在，或内容已不再公开。" : "页面暂时无法显示，请重新加载后再试。"}
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2.5">
          {!notFound && <Link reloadDocument to={pathname + search + hash} className={buttonClass("primary")}>
            重新加载
          </Link>}
          <Link reloadDocument to="/" className={buttonClass(notFound ? "primary" : "secondary")}>
            回到精选
          </Link>
          <Link reloadDocument to="/all" className={buttonClass("secondary")}>
            浏览全部动态
          </Link>
        </div>
      </div>
    </div>
  );
  // Admin errors stay inside the admin's own chrome.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return body;
  return <SiteShell changelogVersion={site?.changelogVersion ?? null}>{body}</SiteShell>;
}
