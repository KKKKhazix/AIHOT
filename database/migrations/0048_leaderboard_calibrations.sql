-- A measuring scale belongs to one method, metric and dataset/protocol. Once established it is
-- immutable: adding a model or refreshing its score cannot move every other model's scale.
CREATE TABLE lb_calibrations (
  methodology_version text NOT NULL,
  unit text NOT NULL,
  protocol text NOT NULL,
  calibration jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (methodology_version, unit, protocol)
);
