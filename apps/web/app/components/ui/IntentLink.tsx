import { useContext, useEffect, useRef, useState } from "react";
import { PrefetchPageLinks, UNSAFE_DataRouterContext, UNSAFE_FrameworkContext, useHref, useLocation, type LinkProps } from "react-router";
import { hasFreshPage } from '../../lib/page-reuse';
import { Link, localizeTo } from "../../lib/link";
import { useLocale } from "../../lib/i18n";

/**
 * Prefetches when the reader presses the link: a mouse or pen button going down, or a touch held
 * still for a moment; scrolling over a card does not. The click follows a press by about a tenth
 * of a second, so the page still arrives early; hovering does not prefetch, because a pointer
 * passing over a list rests on far more links than the reader opens.
 */
export function IntentLink({ onPointerDown, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, ...props }: Omit<LinkProps, "prefetch">) {
  const location = useLocation();
  // A press belongs to the page it was made on: it serves the navigation it starts, and a link that
  // stays on screen (a tab) does not keep prefetching once the reader is somewhere else.
  const [pressedOn, setPressedOn] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const cancel = () => { clear(); setPressedOn(null); };
  useEffect(() => { cancel(); return clear; }, [props.to]);
  return <><Link {...props} prefetch="none"
    onPointerDown={(e) => {
      onPointerDown?.(e);
      if (!e.defaultPrevented && e.pointerType !== "touch" && e.button === 0) setPressedOn(location.key);
    }}
    onTouchStart={(e) => {
      onTouchStart?.(e);
      if (e.defaultPrevented) return;
      clear();
      const on = location.key;
      timer.current = setTimeout(() => { timer.current = null; setPressedOn(on); }, 100);
    }}
    onTouchMove={(e) => { onTouchMove?.(e); cancel(); }}
    onTouchEnd={(e) => { onTouchEnd?.(e); cancel(); }}
    onTouchCancel={(e) => { onTouchCancel?.(e); cancel(); }}
  />{pressedOn === location.key && <PressedPrefetch to={props.to} />}</>;
}

function PressedPrefetch({ to }: Pick<LinkProps, "to">) {
  const location = useLocation();
  // What the link will open: the address Link resolves to in this page's language (lib/link.tsx).
  const href = useHref(localizeTo(to, useLocale()));
  const context = useContext(UNSAFE_DataRouterContext);
  const framework = useContext(UNSAFE_FrameworkContext);
  // Router prefetch loads chunks but opts clientLoader routes out of data prefetch. Their
  // serverLoader still reads this same single-fetch URL; prefetch it with the same browser TTL.
  const target = new URL(href, 'http://page.local');
  const differentPage = target.pathname + target.search !== location.pathname + location.search;
  // Router prefetch also asks shouldRevalidate. A selected/remembered page needs neither its
  // assets nor that revalidation decision, which is reserved for an actual refresh. The prefetch is
  // mounted here rather than through Link's prop: Link keeps prefetching after the prop is switched
  // off, and would ask that question again about the page its own click has just opened.
  if (!differentPage || hasFreshPage(target)) return null;
  const clients = href.startsWith('/') && !href.startsWith('//')
    ? context?.router.match(href)?.filter(m => framework?.manifest.routes[m.route.id]?.hasLoader && framework.manifest.routes[m.route.id]?.hasClientLoader).map(m => m.route.id) ?? []
    : [];
  if (clients.length === 0) return <PrefetchPageLinks page={href} />;
  target.hash = '';
  target.pathname += target.pathname.endsWith('/') ? '_.data' : '.data';
  target.searchParams.set('_routes', clients.join(','));
  return <><PrefetchPageLinks page={href} /><link rel="prefetch" as="fetch" href={target.pathname + target.search} /></>;
}
