import { createHash, randomBytes, randomUUID } from "node:crypto";
import { init } from "@paralleldrive/cuid2";

// 25 lowercase alphanumerics starting with a letter (cuid2): matches ^[a-zA-Z0-9_-]{1,80}$.
const cuid25 = init({ length: 25 });

export function newArticleId(): string {
  return cuid25();
}

export function newUuid(): string {
  return randomUUID();
}

export function newShortId(bytes = 9): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function shortHash(value: string, length = 16): string {
  return sha256(value).slice(0, length);
}

export { stableJson } from "@aihot/contracts/sync";
