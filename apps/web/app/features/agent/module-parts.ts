import { namesEn } from "@aihot/contracts/i18n";
// The site's modules' parts of the agent page (AgentPart), loaded with the page.
import { L, type Phrase } from "../../lib/i18n";
import type { AgentPart } from "../../modules";
import { loadParts } from "../../site-modules";

export const AGENT_PARTS: readonly AgentPart[] = (await loadParts((m) => m.agent)).map(({ part }) => part);

/** The tag on what visitors copy: the first module's. */
export const TAG = AGENT_PARTS.find((p) => p.tag)?.tag ?? null;

const clients = AGENT_PARTS.flatMap((p) => p.guideClients ?? []);
/** The modules' clients built on the Agent guide, by name, as the page lists them; null when there are none. */
export const GUIDE_CLIENTS: Phrase | null = clients.length ? L(clients.join("、"), namesEn(clients)) : null;
