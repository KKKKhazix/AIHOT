-- The publisher's cover (content/cover.ts), shown above a body without a picture of its own.
-- Kept apart from body_html, which a feed may send again; old rows have none until filled.
ALTER TABLE articles ADD COLUMN cover jsonb;
