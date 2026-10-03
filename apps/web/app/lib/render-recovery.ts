// A public render error can outlive its deployment: replace an outdated document once per tab.
import { isRouteErrorResponse } from "react-router";
import type { HydrationOptions } from "react-dom/client";

const RECOVERY_RELEASE_KEY = "aihot-render-recovery-release";

export function createRenderErrorHandler(documentRelease: string | null) {
  let checking = false;
  return async (error: unknown, info: Parameters<NonNullable<HydrationOptions["onCaughtError"]>>[1]) => {
    console.error(error, info);
    const failedUrl = window.location.href;
    if (isRouteErrorResponse(error) || /^\/admin(?:\/|$)/.test(new URL(failedUrl).pathname)
      || !documentRelease || documentRelease === "dev" || checking) return;
    checking = true;
    try {
      // If storage is blocked, manual reload stays available without risking a reload loop.
      const storage = window.sessionStorage;
      if (storage.getItem(RECOVERY_RELEASE_KEY) === documentRelease) return;
      const response = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return;
      const health = await response.json() as { ok?: unknown; release?: unknown };
      if (health.ok !== true || typeof health.release !== "string" || !health.release
        || health.release === "dev" || health.release === documentRelease) return;
      if (window.location.href !== failedUrl) return;
      storage.setItem(RECOVERY_RELEASE_KEY, documentRelease);
      window.location.reload();
    } catch {
      // An unavailable health check or storage must leave the original error and retry visible.
    } finally {
      checking = false;
    }
  };
}
