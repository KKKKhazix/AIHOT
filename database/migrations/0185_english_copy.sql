-- The English edition's words for the Chinese the site shows (publication/english.ts): a title, summary, reason,
-- event digest, report paragraph or source name, kept under the hash of the whole text (one can outgrow an index
-- entry). A changed text is another key, so English never outlives the Chinese it says. original_of: the article
-- whose original title went with the text to the model; once that article is withdrawn or its original withheld, the
-- row is not used and the text is translated again without it. en is null while the text fails; failures counts its attempts
-- (three at most; one whose outcome is unknown counts as all but the last). held_by: the request whose outcome is unknown
-- (it may have been billed); the text waits until that request is released, then is tried once more.
CREATE TABLE IF NOT EXISTS english_copy (
  zh_hash       text PRIMARY KEY,
  zh            text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('headline', 'text', 'name')),
  en            text,
  original_of   text,
  failures      integer NOT NULL DEFAULT 0,
  held_by       bigint,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
