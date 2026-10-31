-- A source's class in the industry pack (industry/selection.ts SELECTION.classes): it raises the
-- selection threshold of its tier to the class floor. NULL: the tier's threshold alone.
ALTER TABLE sources ADD COLUMN selection_class text;
