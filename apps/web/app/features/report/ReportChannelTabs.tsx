import { NavLink } from "react-router";

export function ReportChannelTabs({ active }: { active: "daily" | "github" }) {
  return (
    <nav aria-label="日报频道" className="mb-6 flex w-full items-center gap-1 rounded-xl border border-line bg-surface p-1 text-[13px]">
      <NavLink to="/daily" className={`flex-1 rounded-lg px-3 py-2 text-center transition-colors ${active === "daily" ? "bg-accent/12 font-semibold text-accent" : "text-ink-3 hover:text-ink"}`}>技术日报</NavLink>
      <NavLink to="/github-daily" className={`flex-1 rounded-lg px-3 py-2 text-center transition-colors ${active === "github" ? "bg-accent/12 font-semibold text-accent" : "text-ink-3 hover:text-ink"}`}>GitHub 日榜</NavLink>
    </nav>
  );
}
