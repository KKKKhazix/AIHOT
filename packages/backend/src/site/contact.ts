// About-page contact codes: replaceable from the admin without code changes (file names carry a content
// hash), or shipped in the industry pack (industry/brand/contact/qr-wechat…, qr-feishu…). The page shows a
// code only when set. The maker block can show the avatar of an X account the site follows as a source
// (ABOUT.maker).
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { ABOUT } from "@aihot/industry/site";
import { REPO_ROOT } from "../config.ts";
import { sql } from "../db.ts";
import { proxiedImage } from "../media/imgproxy.ts";

export interface ContactSettings {
  wechatQr: string | null;
  feishuQr: string | null;
}

const PACK_CODES = path.join(REPO_ROOT, "industry/brand/contact");

/** The pack's code for a slot, served under /contact/; none when the pack ships no such file. */
function packCode(slot: "wechat" | "feishu"): string | null {
  const file = existsSync(PACK_CODES) ? readdirSync(PACK_CODES).sort().find((f) => f.startsWith(`qr-${slot}`) && /^[\w.-]+\.(png|jpe?g|webp)$/.test(f)) : undefined;
  return file ? `/contact/${file}` : null;
}

const DEFAULTS: ContactSettings = { wechatQr: packCode("wechat"), feishuQr: packCode("feishu") };

export async function loadContact(): Promise<ContactSettings> {
  const [row] = await sql<{ value: Partial<ContactSettings> }[]>`SELECT value FROM settings WHERE key = 'contact_qr'`;
  return { ...DEFAULTS, ...(row?.value ?? {}) };
}

/** The maker's avatar at 400px through the image proxy, or null without a maker source or icon. */
export async function loadMakerAvatar(): Promise<string | null> {
  const sourceId = ABOUT.maker?.avatarSourceId;
  if (!sourceId) return null;
  const [row] = await sql<{ icon_url: string | null }[]>`SELECT icon_url FROM sources WHERE id = ${sourceId}`;
  const icon = row?.icon_url?.replace(/_(normal|bigger|mini)(\.\w+)$/, "_400x400$2") ?? null;
  return proxiedImage(icon, "thumb");
}
