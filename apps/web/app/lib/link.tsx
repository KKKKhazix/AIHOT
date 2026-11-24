// Site links in the page's language: on an English page a link to a page that has an English edition goes to its
// /en address (lib/i18n.ts localizePath). Web code takes Link, NavLink and useNavigate from here, not from
// react-router (architecture test "site links keep the page's language").
import { useCallback } from "react";
import {
  Link as RouterLink, NavLink as RouterNavLink, useNavigate as useRouterNavigate,
  type LinkProps, type NavigateOptions, type NavLinkProps, type To,
} from "react-router";
import { localizePath, useLocale, type Locale } from "./i18n.ts";

/** `to` in the page's language; a path object keeps its search and hash. */
export function localizeTo(to: To, locale: Locale): To {
  if (locale !== "en") return to;
  if (typeof to === "string") return localizePath(to, locale);
  if (!to.pathname) return to;
  return { ...to, pathname: localizePath(to.pathname, locale) };
}

export function Link({ to, ...props }: LinkProps) {
  return <RouterLink to={localizeTo(to, useLocale())} {...props} />;
}

export function NavLink({ to, ...props }: NavLinkProps) {
  return <RouterNavLink to={localizeTo(to, useLocale())} {...props} />;
}

export function useNavigate(): (to: To | number, options?: NavigateOptions) => void | Promise<void> {
  const navigate = useRouterNavigate();
  const locale = useLocale();
  return useCallback((to: To | number, options?: NavigateOptions) => (typeof to === "number" ? navigate(to) : navigate(localizeTo(to, locale), options)), [navigate, locale]);
}
