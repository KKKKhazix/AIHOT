import { Link, Outlet } from "react-router";
import { SITE } from "@aihot/industry/site";
import { BoardTabs } from "../features/leaderboard/BoardTabs";
import { IconArrowUpRight, IconInfo } from "../components/icons";
import { PhoneBar } from "../components/shell/PhoneBar";
import type { Screen } from "../components/shell/screens";
import { edgeTtl } from "../lib/api.server";

export const handle: Screen = { tab: "leaderboard", name: "模型榜" };

export function headers() {
  return edgeTtl(300);
}

/** Shared frame for the overall and category boards; only the board below it changes. */
export default function LeaderboardFrame() {
  const chip = "inline-flex h-8 items-center gap-1 rounded-full border border-line-strong bg-surface px-3.5 text-[12.5px] text-ink-2 transition-colors hover:border-ink-4 hover:text-ink";
  return (
    <div className="pb-10">
      <PhoneBar
        title="模型榜"
        large
        actions={
          <Link viewTransition to="/leaderboard/rules" className="flex h-11 items-center gap-1 px-3 text-[14px] text-accent active:opacity-50">
            <IconInfo size={17} /> 怎么算
          </Link>
        }
      />
      <header className="hidden flex-col gap-3 pb-4 pt-1 sm:flex-row sm:items-end sm:justify-between lg:flex">
        <div>
          <div className="mono text-[11px] font-semibold tracking-[0.16em] text-accent">{SITE.name.toUpperCase()} LEADERBOARD</div>
          <h1 className="mt-1.5 text-[24px] font-semibold leading-[1.3] text-ink">AI 模型排行榜</h1>
        </div>
        <div className="flex gap-2">
          <Link viewTransition to="/leaderboard/sources" className={chip}>
            评测来源 <IconArrowUpRight size={13} />
          </Link>
          <Link viewTransition to="/leaderboard/rules" className={chip}>
            排序怎么算 <IconArrowUpRight size={13} />
          </Link>
        </div>
      </header>
      <div className="bleed lg:mx-0 lg:px-0">
        <BoardTabs />
      </div>
      <Outlet />
    </div>
  );
}
