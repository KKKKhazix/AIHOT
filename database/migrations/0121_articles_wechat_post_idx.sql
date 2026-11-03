-- Historical signed keys and current account/post keys must resolve without scanning the material archive.
CREATE INDEX CONCURRENTLY IF NOT EXISTS articles_wechat_post_idx
  ON articles ((split_part(identity_key, '&sn=', 1)))
  WHERE starts_with(identity_key, 'url:https://mp.weixin.qq.com/s?__biz=') AND identity_key NOT LIKE '%#%';
