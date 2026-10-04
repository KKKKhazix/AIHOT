import type { Config } from "@react-router/dev/config";

export default {
  ssr: true,
  appDirectory: "app",
  buildDirectory: "build",
  // The whole route manifest ships with the page: no /__manifest?paths=… requests, whose answers are
  // cacheable for a year while a CDN's page cache would not key them on paths or version.
  routeDiscovery: { mode: "initial" },
  // The page loader and component share tiny entry wrappers. Splitting their exports creates extra
  // serial requests before a cold navigation can read data; keep each route's exports together.
  splitRouteModules: false,
} satisfies Config;
