import assert from "node:assert/strict";
import { test } from "node:test";
import { identityKeyForUrl, normalizeUrl, tweetIdFromUrl } from "../packages/backend/src/lib/url.ts";

test("X and Twitter status URL variants keep the same material identity", () => {
  for (const host of ["x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.twitter.com", "m.twitter.com"]) {
    for (const path of ["/openai/status/1234567890", "/openai/statuses/1234567890", "/i/status/1234567890"]) {
      const url = `https://${host}${path}?s=20#thread`;
      assert.equal(tweetIdFromUrl(url), "1234567890", url);
      assert.equal(identityKeyForUrl(url), "x:1234567890", url);
    }
  }
  assert.equal(tweetIdFromUrl("http://TWITTER.COM/openai/status/1234567890/photo/1"), "1234567890");
});

test("other sites containing a tweet URL keep their own material identity", () => {
  const tweet = "https://x.com/openai/status/1234567890";
  const urls = [
    `https://news.example.org/article/42?related=${tweet}`,
    `https://news.example.org/article/42#${tweet}`,
    `https://news.example.org/archive/${tweet}`,
    "https://notx.com/openai/status/1234567890",
    "https://nottwitter.com/openai/status/1234567890",
    "https://x.com.example.org/openai/status/1234567890",
    "https://x.com@news.example.org/openai/status/1234567890",
  ];
  for (const url of urls) {
    assert.equal(tweetIdFromUrl(url), null, url);
    assert.equal(identityKeyForUrl(url), `url:${normalizeUrl(url)}`, url);
    assert.notEqual(identityKeyForUrl(url), identityKeyForUrl(tweet), url);
  }
});

test("only a complete status id at the expected path identifies a tweet", () => {
  for (const url of [
    "https://x.com/search?q=https://x.com/openai/status/1234567890",
    "https://x.com/archive/openai/status/1234567890",
    "https://x.com/openai/status/1234567890junk",
    "https://x.com/openai/status/",
    "https://x.com/openai/status/not-a-number",
  ]) assert.equal(tweetIdFromUrl(url), null, url);
});

test("invalid and non-HTTP URLs cannot acquire a tweet identity", () => {
  for (const url of ["not a URL", "x.com/openai/status/1234567890", "ftp://x.com/openai/status/1234567890"]) {
    assert.equal(tweetIdFromUrl(url), null, url);
    assert.equal(identityKeyForUrl(url), null, url);
  }
});

// A readable WeChat short link can omit sn; it is an access parameter, not a different post.
test('WeChat post identity uses the publisher and mid/idx across signatures and short access links',()=>{
  const base='https://mp.weixin.qq.com/s?__biz=publisher%3D%3D&mid=224700001&idx=1';
  for(const url of [base+'&sn=first',base+'&sn=changed','https://mp.weixin.qq.com/s/short?scene=126&__biz=publisher%3D%3D&mid=224700001&idx=1'])
    assert.equal(identityKeyForUrl(url),'url:'+base);
  for(const url of [base.replace('publisher','another'),base.replace('224700001','224700002'),base.replace('idx=1','idx=2')])
    assert.notEqual(identityKeyForUrl(url),identityKeyForUrl(base));
  for(const url of ['https://mp.weixin.qq.com/s/short','https://example.com/s?__biz=publisher%3D%3D&mid=224700001&idx=1'])
    assert.equal(identityKeyForUrl(url),'url:'+normalizeUrl(url));
});
