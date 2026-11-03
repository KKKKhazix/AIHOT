-- Verified publisher identity also finds a post first stored under its short access URL.
CREATE INDEX CONCURRENTLY IF NOT EXISTS articles_wechat_external_id_idx
  ON articles ((raw->>'externalId'))
  WHERE starts_with(raw->>'externalId', 'https://mp.weixin.qq.com/s?__biz=');
