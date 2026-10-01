-- 旧会话保留为空，由新鉴权逻辑要求重新登录；旧代码仍可写入原有字段。
ALTER TABLE admin_sessions
  ADD COLUMN auth_method text CHECK (auth_method IN ('password', 'feishu')),
  ADD COLUMN auth_binding text,
  ADD COLUMN auth_claims jsonb;
