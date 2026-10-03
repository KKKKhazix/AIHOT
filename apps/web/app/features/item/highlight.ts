// Syntax colours for code in article bodies, loaded only on pages that have code. Sanitised bodies keep
// code as plain text; the language is guessed here and the colours are dropped when the guess is weak.
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LABELS: Record<string, string> = {
  bash: "Shell", css: "CSS", javascript: "JavaScript", json: "JSON", markdown: "Markdown", python: "Python", sql: "SQL",
  typescript: "TypeScript", xml: "HTML / XML", yaml: "YAML",
};
for (const [name, language] of Object.entries({ bash, css, javascript, json, markdown, python, sql, typescript, xml, yaml })) hljs.registerLanguage(name, language);

/** Coloured HTML (escaped text and hljs spans only) and a language label, or null when unsure. */
export function highlightCode(source: string): { html: string; label: string } | null {
  const text = source.replace(/\r\n?/g, "\n");
  const length = text.trim().length;
  if (length < 40 || length > 12_000) return null;
  const result = hljs.highlightAuto(text, Object.keys(LABELS));
  if (!result.language || result.relevance < 4) return null;
  const clear = result.relevance >= 6 && result.relevance - (result.secondBest?.relevance ?? 0) >= 2;
  return { html: result.value, label: clear ? (LABELS[result.language] ?? "代码") : "代码" };
}
