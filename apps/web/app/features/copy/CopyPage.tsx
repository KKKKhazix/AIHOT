import type { ReactNode } from "react";
import type { CopyDocument, RenderedCopy } from "../../lib/markdown";
import { ArticleLayout, RailSection } from "../../components/ui/Page";
import { PhoneBar } from "../../components/shell/PhoneBar";
import { Link } from "../../lib/link";
import { useT, zh } from "../../lib/i18n";
import { jumpTo } from "../../lib/motion";

/**
 * Legal and policy pages, read like articles: the document on the page in one column, its facts in the
 * left rail and its outline in the right (phones and narrow desktops get the facts above the text and no
 * outline).
 */
export function CopyPage({ doc, rendered, eyebrow, footer }: { doc: CopyDocument; rendered: RenderedCopy; eyebrow?: ReactNode; footer?: ReactNode }) {
  const t = useT();
  // Keys of the document's own meta table, shown as the document writes them: its pages have no English edition.
  const facts = [zh("版本"), zh("生效日期"), zh("运营主体"), zh("联系方式"), zh("备案号")].filter((k) => doc.meta[k]);
  const info = facts.length > 0 && (
    <RailSection title={t("文档信息", "Document info")}>
      <dl className="space-y-2 text-ui-caption-lg">
        {facts.map((k) => (
          <div key={k}>
            <dt className="text-ink-4">{k}</dt>
            <dd className="mt-0.5 text-ink-2">{doc.meta[k]}</dd>
          </div>
        ))}
      </dl>
    </RailSection>
  );
  const outline = rendered.outline.length > 2 && (
    <RailSection title={t("目录", "Contents")}>
      <nav aria-label={t("目录", "Contents")}>
        <ol className="-ml-px space-y-0.5 border-l border-line">
          {rendered.outline.map((o) => (
            <li key={o.id}>
              <a href={`#${o.id}`} onClick={(e) => jumpTo(e, o.id)} className="-ml-px block border-l border-transparent py-1 pl-3 text-ui-caption-lg leading-snug text-ink-3 transition-colors hover:border-accent hover:text-ink">
                {o.text}
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </RailSection>
  );
  return (
    <>
    <PhoneBar back={{ to: "/more", label: t("我的", "Me") }} title={doc.title} />
    <ArticleLayout
      left={info}
      right={
        <>
          <div className="space-y-8 2xl:hidden">{info}</div>
          {outline}
        </>
      }
    >
      <article className="pb-14 pt-3 lg:pt-2">
        {eyebrow && <div className="mb-2.5 text-ui-caption font-semibold text-accent">{eyebrow}</div>}
        <h1 data-page-title="" className="text-ui-title-2 font-bold leading-[1.35] text-ink lg:text-ui-title-6 xl:text-ui-display-2 xl:leading-[1.3]">{doc.title}</h1>
        {doc.intro && <p className="mt-4 text-ui-body leading-[1.8] text-ink-3 xl:text-ui-body-lg">{doc.intro}</p>}
        {facts.length > 0 && (
          <dl className="mt-5 grid grid-cols-1 border-y border-line text-ui-caption-lg sm:grid-cols-2 side:hidden">
            {facts.map((k) => (
              <div key={k} className="flex gap-4 border-b border-line-soft py-2.5 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0">
                <dt className="w-16 shrink-0 text-ink-4">{k}</dt>
                <dd className="min-w-0 text-ink-2">{doc.meta[k]}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="prose prose-compact mt-6 lg:mt-8" dangerouslySetInnerHTML={{ __html: rendered.html }} />
        {footer && <div className="mt-12 border-t border-line pt-5 text-ui-caption-lg text-ink-3">{footer}</div>}
      </article>
    </ArticleLayout>
    </>
  );
}

export function LegalFooterLinks({ links, note }: { links: Array<{ to: string; label: string; id?: string }>; note?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {links.map((l) => (
        <Link key={l.to} id={l.id} to={l.to} className="text-accent hover:underline">{l.label}</Link>
      ))}
      {note && <span className="text-ink-4">{note}</span>}
    </div>
  );
}
