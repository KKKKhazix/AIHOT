import path from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { isApiOwned, resolveRedirect } from "@aihot/contracts/http-policy";
import { DEPLOYMENT } from "@aihot/site";
import { proxyToApi } from "./app/lib/api-proxy.server.ts";

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
        // The api sees the Host it gets in production.
        if (DEPLOYMENT.originHost) req.headers.host = DEPLOYMENT.originHost;
        proxyToApi(req, res);
      });
    },
  };
}

export default defineConfig({
  plugins: [devEdge(), tailwindcss(), reactRouter()],
  // The modules' pages import the engine's web code by this name (tsconfig.json paths).
  resolve: { alias: { "@aihot/web/": `${path.resolve(import.meta.dirname, "app")}/` } },
  server: { port: 3000, strictPort: true },
  build: {
    rolldownOptions: {
      output: {
        // A page used to load 15–30 small shared chunks. Framework code stays one stable chunk across
        // releases; app code that at least four public routes share, the site's and the industry pack's included, is
        // one chunk (7–10 files a page); the rest keeps automatic splitting. Motion is left to the admin
        // pages, the agent page's building blocks to that page and the modules' parts of it.
        codeSplitting: {
          groups: [
            { name: "framework", test: /node_modules[\\/](?:react|react-dom|scheduler|react-router|@react-router|cookie|set-cookie-parser|turbo-stream)[\\/]/, priority: 30 },
            { name: "motion", test: /node_modules[\\/](?:motion|framer-motion|motion-dom|motion-utils)[\\/]/, priority: 20 },
            { name: "shared", test: /apps[\\/]web[\\/]app[\\/](?!features[\\/](?:admin|agent)[\\/]|routes[\\/])|[\\/](?:industry|site)[\\/]/, minShareCount: 4, priority: 10 },
          ],
        },
      },
    },
  },
});
