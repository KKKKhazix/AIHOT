-- The Feishu sign-in's claims, unread since Feishu sign-in was removed (2026-11-15); deletion approved (2026-11-15).
ALTER TABLE admin_sessions DROP COLUMN IF EXISTS auth_claims;
