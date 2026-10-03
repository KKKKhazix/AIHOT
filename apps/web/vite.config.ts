import { request as httpRequest } from "node:http";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { isApiOwned, resolveRedirect } from "@aihot/contracts/http-policy";
import { API_BASE_URL } from "./app/lib/api.server.ts";

const API = new URL(API_BASE_URL);

/** Development stand-in for the production web server: the shared redirect table and api-owned path routing. */
function devEdge(): Plugin {
  return {
    name: "aihot-dev-edge",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = req.url ?? "/";
        const qi = raw.indexOf("?");
        const pathname = qi >= 0 ? raw.slice(0, qi) : raw;
        const search = qi >= 0 ? raw.slice(qi) : "";
        if (pathname.startsWith("/@") || pathname.startsWith("/node_modules/") || pathname.startsWith("/app/") || pathname.startsWith("/__")) return next();
        const decision = resolveRedirect(pathname, search);
        if (decision) {
          for (const [k, v] of Object.entries(decision.headers)) res.setHeader(k, v);
          if (decision.location) res.setHeader("Location", decision.location);
          res.statusCode = decision.status;
          return res.end();
        }
        if (!isApiOwned(pathname)) return next();
        const upstream = httpRequest(
          { hostname: API.hostname, port: API.port, path: raw, method: req.method, headers: req.headers },
          (up) => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
          },
        );
        upstream.on("error", () => {
          res.statusCode = 502;
          res.end("api unavailable");
        });
        req.pipe(upstream);
      });
    },
  };
}

export default defineConfig({
  plugins: [devEdge(), tailwindcss(), reactRouter()],
  server: { port: 3000, strictPort: true },
  build: {
    rolldownOptions: {
      output: {
        // A page used to load 15–30 small shared chunks. Framework code stays one stable chunk across
        // releases; app code that at least four public routes share, the industry pack's included, is
        // one chunk (7–10 files a page); the rest keeps automatic splitting. Motion is left to the admin
        // pages.
        codeSplitting: {
          groups: [
            { name: "framework", test: /node_modules[\\/](?:react|react-dom|scheduler|react-router|@react-router|cookie|set-cookie-parser|turbo-stream)[\\/]/, priority: 30 },
            { name: "motion", test: /node_modules[\\/](?:motion|framer-motion|motion-dom|motion-utils)[\\/]/, priority: 20 },
            { name: "shared", test: /apps[\\/]web[\\/]app[\\/](?!features[\\/]admin[\\/]|routes[\\/])|[\\/]industry[\\/]/, minShareCount: 4, priority: 10 },
          ],
        },
      },
    },
  },
});
