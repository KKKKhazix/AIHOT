// Shared setup for the invariant tests (node --test tests/). They write rows, so they refuse to run
// unless DATABASE_URL names a throwaway database ending in _test or _ci (CI: a freshly migrated one).
// Secrets are test values set here, never real credentials; paid providers are pointed at
// local stubs by the tests that need them, and the push valves stay off. The files share
// one database and its paid-service budgets, so they run one at a time (package.json).
import http from "node:http";

const database = new URL(process.env.DATABASE_URL ?? "postgres://unset/unset").pathname.slice(1);
if (!/_(test|ci)$/.test(database)) {
  throw new Error(`Invariant tests write rows: point DATABASE_URL at a throwaway database named *_test or *_ci (got "${database}")`);
}
process.env.AIHOT_CREDENTIALS_DIR = "/nonexistent-test-credentials";
process.env.SESSION_SECRET ??= "test-session-secret-0123456789";
process.env.IMG_PROXY_SIGN_SECRET ??= "test-img-secret-0123456789";
process.env.FEISHU_CONTENT_PUSH_ENABLED = "false";
process.env.INDEXNOW_SUBMIT_ENABLED = "false";
process.env.LOG_LEVEL ??= "error";
// The tests were written against the named model presets AIHOT assigns to each step (each provider is
// pointed at a local stub by the test that needs it). The open-source default is one model for every
// step, which tests/default-model.test.ts covers.
const AIHOT_MODELS: Record<string, string> = {
  PREFILTER_MODEL: "qwen3.7-flash", SCORE_MODEL: "glm-5.3-flash-selection", UNDERSTAND_MODEL: "glm-5.3-flash", SUMMARIZE_MODEL: "deepseek-flash",
  STRUCTURE_MODEL: "qwen3.8-flash", GROUP_MODEL: "deepseek-flash", GROUP_REVIEW_MODEL: "mimo-v2.6-flash", DIGEST_MODEL: "deepseek-flash",
  REPORT_MODEL: "deepseek-flash", TRANSLATE_MODEL: "deepseek-flash", MONITOR_MODEL: "deepseek-flash",
};
for (const [name, model] of Object.entries(AIHOT_MODELS)) process.env[name] ??= model;

/**
 * A local HTTP stub standing in for a paid provider; `answer` builds every response from the request
 * (it may wait, to hold a request open while a test changes something).
 */
let localProviders = 0;
let previousModelCalls = false;

export async function stub(answer: (hit: number, req: { url: string; body: string }) => unknown) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      hits += 1;
      const out = await answer(hits, { url: req.url ?? "/", body: Buffer.concat(chunks).toString("utf8") });
      const reply = out instanceof Reply ? out : { status: 200, json: out };
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { config } = await import("@aihot/backend/config");
  if (localProviders++ === 0) previousModelCalls = config.modelCallsEnabled;
  config.modelCallsEnabled = true;
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, hits: () => hits, close: () => new Promise<void>((resolve) => server.close(() => {
    if (--localProviders === 0) config.modelCallsEnabled = previousModelCalls;
    resolve();
  })) };
}

/** A stub answer with its own status (e.g. a provider's 503); anything else is a 200 JSON body. */
export class Reply {
  readonly status: number;
  readonly json: unknown;
  constructor(status: number, json: unknown) {
    this.status = status;
    this.json = json;
  }
}

/** A promise with its resolve function, to hold a stub's answer until a test releases it. */
export function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

/** A short unique tag for the rows a test creates. */
export const tag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
