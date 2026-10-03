-- 管理员会话也可以来自密码登录（ADMIN_PASSWORD），不只是飞书；两种都允许的数据库不受影响。
ALTER TABLE admin_sessions DROP CONSTRAINT IF EXISTS admin_sessions_auth_method_check;
ALTER TABLE admin_sessions ADD CONSTRAINT admin_sessions_auth_method_check CHECK (auth_method IN ('password', 'feishu'));
