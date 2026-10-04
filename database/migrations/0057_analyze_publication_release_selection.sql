-- Collect the new joint statistics before queries choose their next execution plan.
ANALYZE publications (visibility, selected, seat, visible_after);
