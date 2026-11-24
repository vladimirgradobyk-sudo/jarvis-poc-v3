-- The Captain model chosen at Configure (demo deviation from DEC-15 / AM-10, which fix the
-- Captain model by policy). NULL means "use the skill's policy-fixed default". The engine
-- resolves run.captain_model ?? captain.defaultModel when it adjudicates.

ALTER TABLE runs ADD COLUMN captain_model TEXT;

INSERT INTO schema_version (version, applied_at) VALUES (4, datetime('now'));
