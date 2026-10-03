-- Display names of leaderboard models rebuilt from slugs split sizes and versions ("Qwen3.4 B" for
-- Qwen3-4B, "MiMo V 2.6 Pro"). These are the models on the public boards, named as their developers
-- name them. Slugs (public URLs) do not change.
UPDATE lb_models AS m SET name = v.name, updated_at = now()
FROM (VALUES
  ('qwen-3-4-b', 'Qwen3-4B'),
  ('qwen-3-14-b', 'Qwen3-14B'),
  ('qwen-3-32-b', 'Qwen3-32B'),
  ('qwen-3-5-27-b', 'Qwen3.5-27B'),
  ('qwen-3-6-27-b', 'Qwen3.6-27B'),
  ('qwen-3-8-27-b', 'Qwen3.8-27B'),
  ('qwen-3-235-b-a-22-b-2507', 'Qwen3-235B-A22B-2507'),
  ('mimo-v-2-5', 'MiMo-V2.5'),
  ('mimo-v-2-5-pro', 'MiMo-V2.5-Pro'),
  ('mimo-v-2-6-pro', 'MiMo-V2.6-Pro'),
  ('minimax-m-3', 'MiniMax-M3'),
  ('gemma-4-31-b-it', 'Gemma 4 31B'),
  ('gpt-oss-120-b', 'gpt-oss-120b'),
  ('gpt-oss-20-b', 'gpt-oss-20b'),
  ('nemotron-3-ultra-550-b-a-55-b', 'Nemotron 3 Ultra')
) AS v(slug, name)
WHERE m.slug = v.slug AND m.name <> v.name;

-- Models the fetchers created before providers were inferred kept the company name but the slug "other".
UPDATE lb_models AS m SET provider_slug = v.provider_slug, updated_at = now()
FROM (VALUES
  ('claude-sonnet-5-5', 'anthropic'),
  ('gpt-6-1-sol', 'openai'),
  ('command-a-plus-05-2026', 'cohere')
) AS v(slug, provider_slug)
WHERE m.slug = v.slug AND m.provider_slug = 'other';
