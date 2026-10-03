// Client-side admin commands: same-origin fetch to /api/admin/* with the session's CSRF token, a
// stable Idempotency-Key per submitted command, and a revalidation of the page's loaders on success.
import { useCallback, useRef, useState } from "react";
import { useRevalidator, useRouteLoaderData } from "react-router";
import type { AdminMe } from "@aihot/contracts/admin";
import { toast } from "./toast";

/** A command the api refused; the message is its explanation. */
class AdminError extends Error {}

function useAdminMe(): AdminMe {
  return (useRouteLoaderData("admin-layout") as { me: AdminMe } | undefined)?.me ?? { name: "", csrf: "", dev: false };
}

function newKey() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useAdminAction() {
  const me = useAdminMe();
  const revalidator = useRevalidator();
  const [pending, setPending] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());

  const run = useCallback(
    async <T = unknown>(
      method: "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
      opts: { success?: string; label?: string; revalidate?: boolean } = {},
    ): Promise<T | null> => {
      const label = opts.label ?? `${method} ${path}`;
      // The same command retried after a failure keeps its key, so paid work is not repeated.
      const key = keys.current.get(label) ?? newKey();
      keys.current.set(label, key);
      setPending(label);
      try {
        const res = await fetch(path, {
          method,
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-csrf-token": me.csrf, "idempotency-key": key },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (res.status === 401) {
          window.location.href = `/api/auth/login?return=${encodeURIComponent(window.location.pathname)}`;
          return null;
        }
        const text = await res.text();
        const json = text ? JSON.parse(text) : null;
        if (!res.ok) throw new AdminError(json?.detail ?? `请求失败（${res.status}）`);
        keys.current.delete(label);
        if (opts.success) toast(opts.success, "ok");
        if (opts.revalidate !== false) revalidator.revalidate();
        // null means failure to callers; an empty success (204) is an empty object.
        return (json ?? {}) as T;
      } catch (error) {
        toast(error instanceof AdminError ? error.message : "网络错误，请稍后再试", "error");
        return null;
      } finally {
        setPending(null);
      }
    },
    [me.csrf, revalidator],
  );

  return { run, pending, busy: pending !== null || revalidator.state === "loading" };
}
