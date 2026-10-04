-- Selection and the release gate are correlated; multiplying their frequencies understates the
-- selected set and makes a full scan plus sort appear cheaper than an ordered index read.
CREATE STATISTICS publications_release_selection_stats (mcv)
  ON visibility, selected, seat, visible_after FROM publications;
