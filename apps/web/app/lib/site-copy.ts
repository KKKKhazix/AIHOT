// Prepare one verbatim document; each route imports only its own published copy.
import { parseCopyFile, renderMarkdown } from "./markdown";
import { siteUrl } from "./seo";

function stripPageNotes(body: string): string {
  return body.replace(/^页脚[^\n]*$/gm, "").trim();
}

export function prepareCopy(md: string, firstSection?: RegExp) {
  const doc = parseCopyFile(md, firstSection);
  const footerLine = /^页脚[：:](.+)$/m.exec(doc.body)?.[1]?.trim() ?? null;
  doc.body = stripPageNotes(doc.body);
  return { doc, rendered: renderMarkdown(doc.body, siteUrl()), footerLine };
}
