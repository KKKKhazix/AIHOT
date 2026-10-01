-- 未绑定的旧会话保留为空；兼容此前已应用会话绑定迁移的数据库，不修改已有绑定。
ALTER TABLE admin_sessions
  ADD COLUMN IF NOT EXISTS auth_method text CHECK (auth_method IN ('password', 'feishu')),
  ADD COLUMN IF NOT EXISTS auth_binding text,
  ADD COLUMN IF NOT EXISTS auth_claims jsonb;
