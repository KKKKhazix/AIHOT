-- What handling a feedback needs: bug (fix it), suggestion (keep it), question (answer it) or other.
-- NULL: not handled yet, or handled before feedback had kinds.
ALTER TABLE feedback ADD COLUMN kind text;
