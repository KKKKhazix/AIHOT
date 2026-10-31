// Uses of sources besides the news pipeline, as the installed modules declare them (ServerModule.sourceUses).
// One collection serves them all: a source names its uses, its pace is the fastest any of them asks for, and
// each module reads the articles of its sources itself.
import { z } from "zod";
import { serverModules, type SourceUse } from "../modules.ts";

/** Every declared use by name; the first module to declare a name keeps it. */
export function sourceUses(): Record<string, SourceUse> {
  const all: Record<string, SourceUse> = {};
  for (const m of serverModules()) for (const [name, use] of Object.entries(m.sourceUses ?? {})) all[name] ??= use;
  return all;
}

/** The admin's names of the declared uses. */
export function useLabels(): Record<string, string> {
  return Object.fromEntries(Object.entries(sourceUses()).map(([name, use]) => [name, use.label]));
}

/** Whether a source's posts are wanted whole, not only as the feed gives them: the news judges an editorial source's, a module reads a used one's. */
export const readsWhole = (s: { participation_mode: string; uses: readonly string[] }) => s.participation_mode === "editorial" || s.uses.length > 0;

/** The longest a source may wait between reads for its uses' sake; Infinity when none asks. */
export function usePace(uses: readonly string[]): number {
  const declared = sourceUses();
  return Math.min(Infinity, ...uses.map((u) => declared[u]?.minutes ?? Infinity));
}

/** A source's uses as the admin writes them: declared ones only, each named once. */
export const SourceUses = z
  .array(z.string())
  .max(10)
  .refine((uses) => uses.every((u) => Object.hasOwn(sourceUses(), u)), {
    error: () => `信源用途只能是已装模块声明的：${Object.keys(sourceUses()).join("、") || "（没有）"}`,
  })
  .transform((uses) => [...new Set(uses)]);
