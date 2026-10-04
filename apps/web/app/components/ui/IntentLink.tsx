import { useContext, useEffect, useRef, useState } from "react";
import { Link, UNSAFE_DataRouterContext, UNSAFE_FrameworkContext, useHref, useLocation, type LinkProps } from "react-router";
import { hasFreshPage } from '../../lib/page-reuse';

/** Hover, keyboard focus and a stationary touch prefetch; scrolling over a card does not. */
export function IntentLink({ onFocus, onBlur, onMouseEnter, onMouseLeave, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, ...props }: Omit<LinkProps, "prefetch">) {
  const [ready, setReady] = useState(false);
  const href = useHref(props.to);
  const location = useLocation();
  const context = useContext(UNSAFE_DataRouterContext);
  const framework = useContext(UNSAFE_FrameworkContext);
  // Router prefetch loads chunks but opts clientLoader routes out of data prefetch. Their
  // serverLoader still reads this same single-fetch URL; prefetch it with the same browser TTL.
  const target = new URL(href, 'http://page.local');
  const differentPage = target.pathname + target.search !== location.pathname + location.search;
  // Router prefetch also asks shouldRevalidate. A selected/remembered page needs neither its
  // assets nor that revalidation decision, which is reserved for an actual refresh.
  const shouldPrefetch = ready && differentPage && !hasFreshPage(target);
  const clients = shouldPrefetch && href.startsWith('/') && !href.startsWith('//')
    ? context?.router.match(href)?.filter(m => framework?.manifest.routes[m.route.id]?.hasLoader && framework.manifest.routes[m.route.id]?.hasClientLoader).map(m => m.route.id) ?? []
    : [];
  target.hash = '';
  target.pathname += target.pathname.endsWith('/') ? '_.data' : '.data';
  target.searchParams.set('_routes', clients.join(','));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const start = () => {
    clear();
    timer.current = setTimeout(() => { timer.current = null; setReady(true); }, 100);
  };
  const cancel = () => { clear(); setReady(false); };
  useEffect(() => { cancel(); return clear; }, [props.to]);
  return <><Link {...props} prefetch={shouldPrefetch ? "render" : "none"}
    onFocus={(e) => { onFocus?.(e); if (!e.defaultPrevented) start(); }}
    onBlur={(e) => { onBlur?.(e); cancel(); }}
    onMouseEnter={(e) => { onMouseEnter?.(e); if (!e.defaultPrevented) start(); }}
    onMouseLeave={(e) => { onMouseLeave?.(e); cancel(); }}
    onTouchStart={(e) => { onTouchStart?.(e); if (!e.defaultPrevented) start(); }}
    onTouchMove={(e) => { onTouchMove?.(e); cancel(); }}
    onTouchEnd={(e) => { onTouchEnd?.(e); cancel(); }}
    onTouchCancel={(e) => { onTouchCancel?.(e); cancel(); }}
  />{clients.length > 0 && <link rel="prefetch" as="fetch" href={target.pathname + target.search} />}</>;
}
