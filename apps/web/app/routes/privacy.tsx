import { POLICY, SITE } from "@aihot/industry/site";
import copy from "@aihot/industry/pages/privacy.md?raw";
import { edgeTtl } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { prepareCopy } from "../lib/site-copy";
import { CopyPage, LegalFooterLinks } from "../features/copy/CopyPage";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "me" };

const PRIVACY = prepareCopy(copy);

export function headers() {
  return edgeTtl(300);
}

export function meta() {
  return pageMeta({ title: "隐私说明", description: POLICY.privacy.description, path: "/privacy", image: "/og/pages/privacy.png" });
}

export default function PrivacyPage() {
  return (
    <CopyPage
      doc={PRIVACY.doc}
      rendered={PRIVACY.rendered}
      eyebrow={SITE.name}
      footer={<LegalFooterLinks links={[{ to: "/terms", label: POLICY.terms.name }, { to: "/feedback", label: "反馈页" }]} note={`隐私说明 ${PRIVACY.doc.meta["版本"] ?? ""} · ${PRIVACY.doc.meta["生效日期"] ?? ""}`} />}
    />
  );
}
