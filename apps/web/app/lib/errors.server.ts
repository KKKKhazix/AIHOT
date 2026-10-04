// One journal line per server error, retaining stacks and request paths without query strings.
import { isRouteErrorResponse } from "react-router";

export function logError(error: unknown, context: { msg: string; method?: string; path?: string; status?: number; upstreamRequestId?: string | null }) {
  const details = (value: unknown) => value instanceof Error
    ? { name: value.name, message: value.message, stack: value.stack }
    : { message: String(value) };
  console.error(JSON.stringify({ level: "error", ...context, path: context.path?.split("?")[0], err: {
    ...details(error), ...(error instanceof Error && error.cause !== undefined ? { cause: details(error.cause) } : {}),
  } }));
}

/** Expected route refusals already appear in access logs. An actual server error keeps its stack. */
export function handleError(error: unknown, { request }: { request: Request }) {
  if (request.signal.aborted) return;
  const routeError = isRouteErrorResponse(error) ? error : null;
  if (routeError && routeError.status < 500) return;
  const cause = routeError && "error" in routeError ? routeError.error : error;
  logError(cause, { msg: "web render failed", method: request.method, path: new URL(request.url).pathname, status: routeError?.status });
}
