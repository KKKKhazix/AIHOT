// The site's modules' parts of the agent page (AgentPart), loaded with the page.
import type { AgentPart } from "../../modules";
import { loadParts } from "../../site-modules";

export const AGENT_PARTS: readonly AgentPart[] = (await loadParts((m) => m.agent)).map(({ part }) => part);

/** The tag on what visitors copy: the first module's. */
export const TAG = AGENT_PARTS.find((p) => p.tag)?.tag ?? null;

/** The modules' clients built on the Agent guide, by name, as the page lists them. */
export const GUIDE_CLIENTS = AGENT_PARTS.flatMap((p) => p.guideClients ?? []).join("、");
