// Two-sentence Chinese descriptions of the ranked projects, for the weekly WeChat push.
//
// The ranking's own description is one line of English from upstream ("Tool for automatic PS5
// executables porting to Linux and Windows"), which tells a Chinese reader nothing at a glance. The
// push therefore rewrites each project's own description into two Chinese sentences.
//
// This is a paid model call, so it goes through the engine's receipts like every other one: the
// identity is the project and the prompt, so re-running a push (or a retry after a failure) reuses the
// answer already paid for instead of buying it again. The step is declared in the module's `models`
// socket, so it appears on the admin's model page and can be switched there or with
// RANK_DESCRIPTION_MODEL.
import { z } from "zod";
import { chatJson } from "@aihot/backend/providers/llm";
import { promptText, promptVersion } from "@aihot/backend/editorial/prompts";
import { modelFor } from "@aihot/backend/editorial/models";
import type { ModelStep } from "@aihot/backend/modules";
import { parseDescription } from "./message.ts";

/** The step's name in `serverModules()[].models` and on the admin model page. */
export const RANK_DESCRIPTION_STEP: ModelStep = {
  label: "GitHub 周飙升榜项目简介（每个项目 2 句中文，给微信推送用）",
  env: "RANK_DESCRIPTION_MODEL",
  purposes: ["rank_project_description"],
};

const PROMPT_VERSION = promptVersion("rank-project-description");

/**
 * The prompt asks for plain text ("description_zh: …") like the pack's other writing prompts, so the
 * reply is read with `json: false` and parseDescription (message.ts) turns it into two sentences.
 */
const Output = z.object({ description_zh: z.coerce.string() });

export interface DescribableProject {
  repo: string;
  /** The project's own one-line description as upstream printed it; null when the edition had none. */
  description: string | null;
}

/**
 * Two Chinese sentences for one project, or null when there is nothing to write from or the model
 * declines. A caller sends the project without a description rather than not at all: the ranking is the
 * point of the push, and the description is an addition to it.
 */
export async function describeProject(project: DescribableProject, attemptTag?: string): Promise<string | null> {
  const source = project.description?.trim();
  if (!source) return null;
  const model = await modelFor("rankDescription");
  const res = await chatJson({
    model,
    purpose: "rank_project_description",
    subject: `github-rank:${project.repo}`,
    promptVersion: PROMPT_VERSION,
    system: "",
    user: promptText("rank-project-description", { repo: project.repo, description: source }),
    schema: Output,
    json: false,
    parse: (content: string) => ({ description_zh: parseDescription(content) ?? "" }),
    temperature: 0.2,
    maxTokens: 400,
    attemptTag,
  });
  return res.data.description_zh || null;
}
