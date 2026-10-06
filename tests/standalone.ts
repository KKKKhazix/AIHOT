// A standalone test must fail if it accidentally starts querying a real database, including through
// an inherited environment. The test setup still enforces the test-only name and external-action valves.
process.env.DATABASE_URL = "postgres://unreachable@127.0.0.1:1/standalone_test";
await import("./setup.ts");
