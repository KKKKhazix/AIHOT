-- The admin's Feishu identity, unread since Feishu sign-in was removed (2026-11-15); deletion approved (2026-11-15).
ALTER TABLE admin_users DROP COLUMN IF EXISTS feishu_union_id;
