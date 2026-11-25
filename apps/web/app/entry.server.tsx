// Streaming SSR with the framework's shell/bot timing and request-aware error logging.
import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter, type EntryContext, type ServerInstrumentation } from "react-router";
import { renderToPipeableStream, type RenderToPipeableStreamOptions } from "react-dom/server";
import { isbot } from "isbot";
import { apiGet, documentRead } from "./lib/api.server.ts";
import { handleError } from "./lib/errors.server.ts";

/** Count just the page reads the root loader marked, with the final wire status (including .data redirects). */
export const instrumentations: ServerInstrumentation[] = [{
  handler(handler) {
    handler.instrument({
      async request(handle, { context }) {
        const result = await handle();
        const headers = context?.get(documentRead);
        if (headers) void apiGet("/api/site/meta", { headers: { ...headers, "x-aihot-ssr-status": String(result.statusCode) } }).catch(() => {});
      },
    });
  },
}];

export { handleError };
export const streamTimeout = 5_000;

export default function handleRequest(request: Request, responseStatusCode: number, responseHeaders: Headers, routerContext: EntryContext): Response | Promise<Response> {
  if (request.method.toUpperCase() === "HEAD") return new Response(null, { status: responseStatusCode, headers: responseHeaders });
  return new Promise((resolve, reject) => {
    let shellRendered = false;
    const userAgent = request.headers.get("user-agent");
    const ready: keyof RenderToPipeableStreamOptions = (userAgent && isbot(userAgent)) || routerContext.isSpaMode ? "onAllReady" : "onShellReady";
    const timer = setTimeout(() => abort(), streamTimeout + 1000);
    const { pipe, abort } = renderToPipeableStream(<ServerRouter context={routerContext} url={request.url} />, {
      [ready]() {
        shellRendered = true;
        const body = new PassThrough({ final(callback) { clearTimeout(timer); callback(); } });
        responseHeaders.set("Content-Type", "text/html");
        pipe(body);
        resolve(new Response(createReadableStreamFromReadable(body), { status: responseStatusCode, headers: responseHeaders }));
      },
      onShellError(error: unknown) {
        clearTimeout(timer);
        reject(error);
      },
      onError(error: unknown) {
        responseStatusCode = 500;
        // Initial shell failures reject above and are recorded once by the router.
        if (shellRendered) handleError(error, { request });
      },
    });
  });
}
