// Server-rendered content must be visible without JavaScript, and the first client render must match it.
// Entrance animations therefore only play, and lists only restore a saved state at once, for components
// mounted after hydration (client-side navigation, loaded-more content).
import { useEffect, useState } from "react";

let hydrated = false;

/** True once the page has hydrated: a component mounting now is not part of the server's HTML. */
export function isHydrated(): boolean {
  return hydrated;
}

/** True when this component mounted after the first hydration, so an entrance animation is safe. */
export function useEntrance(): boolean {
  const [entrance] = useState(isHydrated);
  return entrance;
}

export function useHydratedFlag() {
  useEffect(() => {
    hydrated = true;
  }, []);
}
