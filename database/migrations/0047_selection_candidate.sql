-- Single-article eligibility remains visible to operations while unresolved identity is kept out
-- of the public selected set. Existing publications retain their current candidate judgement.
ALTER TABLE publications ADD COLUMN selection_candidate boolean NOT NULL DEFAULT false;
UPDATE publications SET selection_candidate = selected;
