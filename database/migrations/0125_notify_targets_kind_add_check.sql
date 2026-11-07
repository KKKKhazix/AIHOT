ALTER TABLE notify_targets ADD CONSTRAINT notify_targets_kind_check CHECK (kind IN ('feishu_webhook', 'feishu_chat', 'log', 'dingtalk_webhook')) NOT VALID;
