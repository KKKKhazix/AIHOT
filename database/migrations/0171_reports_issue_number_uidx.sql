CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS reports_kind_issue_number_uidx ON reports (kind, issue_number) WHERE issue_number IS NOT NULL;
