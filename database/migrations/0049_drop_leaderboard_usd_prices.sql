-- Model prices live in lb_prices since 0007 (official, subscription and relay prices apart, each in its
-- own currency); the two USD columns the first schema put on lb_models are read and written by nothing.
ALTER TABLE lb_models DROP COLUMN IF EXISTS input_price_usd, DROP COLUMN IF EXISTS output_price_usd;
