export const AIHOT_CATEGORIES = ["ai-models", "ai-products", "industry", "paper", "tip", "opinion"] as const;

export interface AiNewsItem {
  id: string;
  title: string;
  summary: string;
  category: string;
  publishedAt: string | null;
  source: { name: string };
  links: { aihot: string; original?: string | null };
  reason?: string | null;
}

export interface AiNewsHotItem {
  rank: number;
  id: string;
  title: string;
  latestAt: string;
  source: { name: string };
  links: { aihot: string; story?: string | null };
  sourceCount: number;
}
