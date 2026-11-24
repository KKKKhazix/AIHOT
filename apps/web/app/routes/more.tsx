import { useEffect, useState, type ReactNode } from "react";
import { useRouteLoaderData } from "react-router";
import { POLICY, SITE } from "@aihot/site";
import { ENGLISH } from "@aihot/contracts/english";
import type { Route } from "./+types/more";
import type { loader as rootLoader } from "../root";
import { useChangelogDot } from "../components/shell/Sidebar";
import { PhoneBar } from "../components/shell/PhoneBar";
import { topicsInNav } from "../components/shell/nav";
import type { Screen } from "../components/shell/screens";
import { edgeTtl } from "../lib/api.server";
import { webModules } from "../site-modules";
import { pageMeta } from "../lib/seo";
import { useStarred } from "../lib/local-state";
import { FontSelect } from "../components/shell/FontSelect";
import { ThemeSwitch } from "../components/shell/ThemeSwitch";
import { Filings } from "../components/shell/Filings";
import { IconBookmark, IconChevronRight, IconGrid, IconHeart, IconMessage, IconMoon, IconPlug, IconSparkles } from "../components/icons";
import { Link } from "../lib/link";
import { hasEnglish, L, localeOf, translator, useLocale, useT, type Locale, type Text } from "../lib/i18n";

export const handle: Screen = { tab: "me", name: L("我的", "Me") };

export function headers() {
  return edgeTtl(300);
}

export function meta({ location }: Route.MetaArgs) {
  const locale = localeOf(location.pathname);
  const t = translator(locale);
  return pageMeta({ locale, title: t("我的", "Me"), path: "/more", noindex: true });
}

/**
 * "我的", the phone's last tab (the address stays /more): this browser's bookmarks and appearance first,
 * then the tools, then the site's own pages.
 */
type Row = { to: string; label: Text; icon: ReactNode; detail?: ReactNode };

/** Whether a row shows on a page in this language: an English page leaves out rows to pages without an English edition. */
const shown = (row: Row, locale: Locale) => locale === "zh" || hasEnglish(row.to.split(/[?#]/)[0]!);

/** The ways in that the agent page offers, the modules' first; its row names the first three. */
const agentWays = () => [...webModules().flatMap((m) => m.agentWays ?? []), "MCP", "RSS", "API"];

/** The modules' tools first, then the engine's. */
const tools = (): Row[] => [
  ...webModules().flatMap((m) => m.tools ?? []),
  ...(topicsInNav ? [{ to: "/topics", label: L("主题", "Topics"), icon: <IconGrid size={20} /> }] : []),
  { to: "/agent", label: L("Agent 接入", "For Agents"), icon: <IconPlug size={20} />, detail: agentWays().slice(0, 3).join(" · ") },
];

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section>
      {title && <h2 className="px-4 pb-2 pt-6 text-ui-label font-semibold text-ink-3">{title}</h2>}
      <ul className="card divide-y divide-line-soft overflow-hidden">{children}</ul>
    </section>
  );
}

function RowLink({ row, dot = false }: { row: Row; dot?: boolean }) {
  const t = useT();
  const locale = useLocale();
  if (!shown(row, locale)) return null;
  return (
    <li>
      <Link viewTransition to={row.to} className="flex min-h-[52px] items-center gap-3 px-4 text-ui-body-lg font-medium text-ink transition-colors active:bg-bg-sunk lg:hover:bg-bg-sunk">
        <span className="text-ink-3">{row.icon}</span>
        <span className="flex flex-1 items-center gap-2">
          {t(row.label)}
          {dot && <span className="size-[7px] rounded-full bg-hot" aria-label={t("有新的更新", "New updates")} />}
        </span>
        {row.detail && <span className="text-ui-body-sm font-normal text-ink-4">{row.detail}</span>}
        <IconChevronRight size={16} className="text-ink-4" />
      </Link>
    </li>
  );
}

export default function MorePage() {
  const t = useT();
  const root = useRouteLoaderData<typeof rootLoader>("root");
  const changelogDot = useChangelogDot(root?.changelogVersion ?? null);
  const starred = useStarred();
  // The count is this browser's: shown once the page runs here, never in the shared server copy.
  const [here, setHere] = useState(false);
  useEffect(() => setHere(true), []);
  const Account = webModules().find((m) => m.account)?.account;
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-8">
      <PhoneBar title={t("我的", "Me")} />
      <h1 data-page-title="" className="pb-3 pt-0.5 text-ui-title-5 font-bold leading-[1.25] tracking-[-0.01em] text-ink lg:pb-4 lg:pt-1 lg:text-ui-heading-lg-sm">{t("我的", "Me")}</h1>
      <div className="wide:grid wide:grid-cols-2 wide:items-start wide:gap-x-4 2xl:grid-cols-3">
        <Group>
          {Account && <Account place="me" />}
          <RowLink row={{ to: "/starred", label: L("收藏", "Saved"), icon: <IconBookmark size={20} />, detail: here && starred.length > 0 ? <span className="num">{starred.length}</span> : undefined }} />
          <li className="flex min-h-[56px] items-center gap-3 px-4 text-ui-body-lg font-medium text-ink">
            <span className="text-ink-3">
              <IconMoon size={20} />
            </span>
            <span className="flex-1">{t("外观", "Appearance")}</span>
            <ThemeSwitch className="w-[126px]" />
          </li>
          <li className="flex min-h-[56px] items-center gap-3 px-4 text-ui-body-lg font-medium text-ink">
            <span className="w-5 text-center text-ink-3" aria-hidden="true">Aa</span>
            <span className="flex-1">{t("字体", "Font")}</span>
            <FontSelect />
          </li>
        </Group>
        <Group title={t("工具与入口", "Tools")}>
          {tools().map((r) => (
            <RowLink key={r.to} row={r} />
          ))}
        </Group>
        <Group title={t("关于", "About")}>
          <RowLink row={{ to: "/about", label: L(`关于 ${SITE.name}`, `About ${SITE.name}`), icon: <IconHeart size={20} /> }} />
          <RowLink row={{ to: "/changelog", label: L("更新日志", "Changelog"), icon: <IconSparkles size={20} /> }} dot={changelogDot} />
          <RowLink row={{ to: "/feedback", label: L("意见反馈", "Feedback"), icon: <IconMessage size={20} /> }} />
        </Group>
      </div>
      <div className="mt-6 flex flex-wrap justify-center gap-x-4 gap-y-1 text-ui-caption leading-[2] text-ink-4">
        {/* The terms and the privacy notice have no English edition: English links to the Chinese pages. */}
        {t(<Link viewTransition to="/terms" className="hover:text-ink-2">{POLICY.terms.name}</Link>, <a href="/terms" className="hover:text-ink-2">{ENGLISH?.policyLinks.terms ?? POLICY.terms.name}</a>)}
        {t(<Link viewTransition to="/privacy" className="hover:text-ink-2">隐私说明</Link>, <a href="/privacy" className="hover:text-ink-2">{ENGLISH?.policyLinks.privacy ?? "Privacy"}</a>)}
        <a href="/feed.xml" className="hover:text-ink-2">RSS</a>
        {SITE.github && <a href={SITE.github} target="_blank" rel="noopener noreferrer" className="hover:text-ink-2">{t("GitHub 开源", "Open source on GitHub")}</a>}
        {SITE.poweredBy && <a href={SITE.poweredBy.url} target="_blank" rel="noopener" className="hover:text-ink-2">{t(<>由 {SITE.poweredBy.name} 驱动</>, <>Powered by {SITE.poweredBy.name}</>)}</a>}
        <Filings className="hover:text-ink-2" badgeSize={13} />
      </div>
    </div>
  );
}
