-- Stored state nothing reads or writes any more (tests/architecture.test.ts names such leftovers):
--   regroup_pending                 the one-off regroup queue, retired with its job
--   story_digests.context_article_ids  the digest's former input record; digests rebuild from the listed reports
--   stories.status                  readers get a status computed from the latest public report
--   sources.imported_from           an import label nothing reads
--   translations.receipt_id         never written
--   admin_users.role                could only ever be 'admin'
--   stored_files                    nothing in this edition stores files through it
--   service_prices.note, verified_on, per_request, source_url  bookkeeping only an operations page read
DROP TABLE IF EXISTS regroup_pending;
ALTER TABLE story_digests DROP COLUMN IF EXISTS context_article_ids;
ALTER TABLE stories DROP COLUMN IF EXISTS status;
ALTER TABLE sources DROP COLUMN IF EXISTS imported_from;
ALTER TABLE translations DROP COLUMN IF EXISTS receipt_id;
ALTER TABLE admin_users DROP COLUMN IF EXISTS role;
DROP TABLE IF EXISTS stored_files;
ALTER TABLE service_prices
  DROP COLUMN IF EXISTS note,
  DROP COLUMN IF EXISTS verified_on,
  DROP COLUMN IF EXISTS per_request,
  DROP COLUMN IF EXISTS source_url;
