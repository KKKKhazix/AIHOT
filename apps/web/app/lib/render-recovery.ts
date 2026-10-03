// A public render error can outlive its deployment: replace an outdated document once per tab. A
// document is outdated when the server no longer has its build: every build replaces the client assets,
// and the build's route manifest (/assets/manifest-<version>.js) is named after it.
import { isRouteErrorResponse, type ClientOnErrorFunction } from "react-router";

const RECOVERY_RELEASE_KEY = "aihot-render-recovery-release";

export function createRenderErrorHandler(documentManifest: string | null) {
  let checking = false;
  return async (error: unknown, info: Parameters<ClientOnErrorFunction>[1]) => {
    console.error(error, info);
    if (!info.errorInfo || isRouteErrorResponse(error) || /^\/admin(?:\/|$)/.test(info.location.pathname)
      || !documentManifest || checking) return;
    const { pathname, search, hash } = info.location;
    const failedUrl = new URL(pathname + search + hash, window.location.href).href;
    if (window.location.href !== failedUrl) return;
    checking = true;
    try {
      // If storage is blocked, manual reload stays available without risking a reload loop.
      const storage = window.sessionStorage;
      if (storage.getItem(RECOVERY_RELEASE_KEY) === documentManifest) return;
      // Only a missing build counts; the same build answering, an error or no answer leave the page alone.
      const response = await fetch(documentManifest, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(5_000) });
      if (response.status !== 404) return;
      if (window.location.href !== failedUrl) return;
      storage.setItem(RECOVERY_RELEASE_KEY, documentManifest);
      window.location.reload();
    } catch {
      // An unavailable check or storage must leave the original error and retry visible.
    } finally {
      checking = false;
    }
  };
}
