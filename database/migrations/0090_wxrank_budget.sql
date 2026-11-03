-- wxrank's WeChat list and article-detail APIs are paid per successful request.
-- Budgets count attempts and remain operator-adjustable from the admin.
INSERT INTO budgets (service, per_minute, per_hour, per_day, note)
VALUES ('wxrank', 5, 60, 500, '公众号列表与正文（微小榜，按请求计费）')
ON CONFLICT (service) DO NOTHING;
