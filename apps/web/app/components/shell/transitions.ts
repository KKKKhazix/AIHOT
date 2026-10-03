// Phones: a page opened one level deeper (an article, an event, a model, a sub-page of 我的) slides in from
// the right over the page it came from, and the bar's back button slides it away again. Such links opt in
// with React Router's `viewTransition`; the router then wraps the page change in a view transition, and
// this marks on <html data-vt> which way it goes for app.css. The browser's own back (a swipe, a button)
// keeps the browser's animation, and the desktop changes pages at once.
import { useLayoutEffect } from "react";
import { useLocation, useNavigationType } from "react-router";
import { isPhone } from "./screens";

let goingBack = false;

/** Called just before navigating back from the app's own controls (the bar's back button, a tab tapped deeper in). */
export function markBack() {
  goingBack = true;
}

/** In the root: marks the direction of each page change while it is committed, before the transition animates. */
export function usePageTransition() {
  const { key } = useLocation();
  const type = useNavigationType();
  useLayoutEffect(() => {
    document.documentElement.dataset.vt = !isPhone() ? "none" : goingBack ? "back" : type === "POP" ? "none" : "push";
    goingBack = false;
  }, [key]);
}
