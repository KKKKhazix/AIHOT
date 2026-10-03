-- The selected seat: among the selected public reports of one fact, only the representative is
-- published to the selected set of v1, RSS and the sync ledger. The website folds the same reports
-- into reading groups instead. Existing rows default to holding a seat; publishing any report of a
-- fact settles that fact.
ALTER TABLE publications ADD COLUMN seat boolean NOT NULL DEFAULT true;
