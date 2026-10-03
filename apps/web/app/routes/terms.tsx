import { POLICY, SITE } from "@aihot/industry/site";
import copy from "@aihot/industry/pages/terms.md?raw";
import { edgeTtl } from "../lib/api.server";
import { pageMeta } from "../lib/seo";
import { prepareCopy } from "../lib/site-copy";
import { CopyPage, LegalFooterLinks } from "../features/copy/CopyPage";
import type { Screen } from "../components/shell/screens";

export const handle: Screen = { tab: "me" };

const TERMS = prepareCopy(copy);

export function headers() {
  return edgeTtl(300);
}

export function meta() {
  return pageMeta({ title: POLICY.terms.name, description: POLICY.terms.description, path: "/terms", image: "/og/pages/terms.png" });
}

export default function TermsPage() {
  return (
    <CopyPage
      doc={TERMS.doc}
      rendered={TERMS.rendered}
      eyebrow={SITE.name}
      footer={
        <LegalFooterLinks
          links={[
            { to: "/privacy", label: "隐私说明" },
            { to: "/agent", label: "Agent 接入页" },
          ]}
          note={`${POLICY.terms.name} ${TERMS.doc.meta["版本"] ?? ""} · ${TERMS.doc.meta["生效日期"] ?? ""}`}
        />
      }
    />
  );
}
