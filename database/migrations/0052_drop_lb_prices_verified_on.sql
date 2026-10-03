-- The day official prices were read is kept in each price file's name and note (database/seeds); the
-- stored copy on lb_prices was never shown.
ALTER TABLE lb_prices DROP COLUMN IF EXISTS verified_on;
