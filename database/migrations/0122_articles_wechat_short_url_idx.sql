-- A short access path names the same post across scene/chksm and fragment variants.
CREATE INDEX CONCURRENTLY IF NOT EXISTS articles_wechat_short_url_idx
  ON articles ((split_part(split_part(url, '?', 1), '#', 1)))
  WHERE starts_with(url, 'https://mp.weixin.qq.com/s/');
