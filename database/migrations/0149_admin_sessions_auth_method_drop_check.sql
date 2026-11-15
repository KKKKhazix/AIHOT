-- Feishu sign-in was removed (2026-11-15): admin sessions come from the password alone. The check is replaced in 0150.
ALTER TABLE admin_sessions DROP CONSTRAINT IF EXISTS admin_sessions_auth_method_check;
