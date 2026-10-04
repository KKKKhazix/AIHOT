// Error diagnostics without database row values, SQL parameters or arbitrary error properties.
// PostgreSQL may put values in its message as well as detail/where, including through a cause.
export interface LoggedError {
  [key: string]: unknown;
  type: string;
  message: string;
  code?: string;
  stack: string;
  cause?: LoggedError;
}

export function logError(error: unknown, depth = 0): LoggedError {
  if (!(error instanceof Error)) return { type: "UnknownError", message: "Non-Error exception", stack: "" };
  const code = (error as Error & { code?: unknown }).code;
  // The query client and the queue use different PostgreSQL drivers.
  const postgres = error.name === "PostgresError" || error.constructor.name === "DatabaseError";
  const prefix = `${error.name}: ${error.message}`;
  const stack = error.stack?.startsWith(prefix)
    ? error.stack.slice(prefix.length).split("\n").filter((line) => /^\s+at /.test(line)).join("\n")
    : undefined;
  return {
    type: error.name,
    message: postgres ? "PostgreSQL request failed" : error.message,
    ...(typeof code === "string" && /^[A-Z0-9_]{2,64}$/.test(code) ? { code } : {}),
    stack: stack ?? "",
    ...(error.cause !== undefined && depth < 3 ? { cause: logError(error.cause, depth + 1) } : {}),
  };
}
