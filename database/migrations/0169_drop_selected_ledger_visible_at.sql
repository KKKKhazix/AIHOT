-- Unwritten and unread since the delayed visibility ended (it always equalled changed_at); deletion approved (2026-11-17). Its index goes with it.
ALTER TABLE selected_ledger DROP COLUMN IF EXISTS visible_at;
