-- The model leaderboard and the Codex reset monitor are no longer part of this edition (4.0.0): their
-- tables, the exchange rates only the leaderboard's prices used, the leaderboard's fetch state and the
-- monitor step's model choice go.
-- Their schedules are unscheduled when the worker starts.
DROP TABLE IF EXISTS lb_rankings, lb_scores, lb_prices, lb_aliases, lb_calibrations, lb_runs, lb_snapshots, lb_models;
DROP TABLE IF EXISTS monitor_event_posts, monitor_events, monitor_posts, monitor_state;
DROP TABLE IF EXISTS fx_rates;
DELETE FROM settings WHERE key IN ('leaderboard.fetch', 'models.monitor');
