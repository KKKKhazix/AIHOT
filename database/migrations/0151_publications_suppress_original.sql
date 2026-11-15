-- Keeps compliant translated copy public while withholding raw source text, media, and original titles.
ALTER TABLE publications ADD COLUMN suppress_original boolean NOT NULL DEFAULT false;
