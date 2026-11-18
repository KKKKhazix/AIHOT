import type { NavItem } from "@aihot/web/components/shell/nav";
import { defineWebModule } from "@aihot/web/modules";

function AiNewsIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h9A1.5 1.5 0 0 1 16 5.5v13a1.5 1.5 0 0 0 1.5 1.5H6a2 2 0 0 1-2-2V5.5Z" />
      <path d="M16 8h2.5A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5H17" />
      <path d="M7.5 8h5M7.5 11.5h5M7.5 15h3.5" />
    </svg>
  );
}

const entry: NavItem = { to: "/ai-news", label: "AI 行业资讯", icon: AiNewsIcon };

export const aiNewsWebModule = defineWebModule({
  name: "ai-news",
  sidebar: { section: "内容", items: [entry] },
  tools: [{ to: "/ai-news", label: "AI 行业资讯", icon: <AiNewsIcon size={18} /> }],
});
