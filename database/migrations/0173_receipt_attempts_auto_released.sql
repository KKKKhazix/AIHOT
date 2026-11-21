ALTER TABLE receipt_attempts ADD COLUMN IF NOT EXISTS auto_released boolean NOT NULL DEFAULT false;
