// Prepare one verbatim document; each route imports only its own published copy.
import { parseCopyFile, renderMarkdown } from "./markdown";
import { siteUrl } from "./seo";

export function prepareCopy(md: string, firstSection?: RegExp) {
  const doc = parseCopyFile(md, firstSection);
  return { doc, rendered: renderMarkdown(doc.body, siteUrl()) };
}
