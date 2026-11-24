-- Per-run G4 scorecard choice (optional accuracy scoring).
--
-- NULL means "fall back to the skill default" (skill.requiresScorecard); 1 forces the scorecard
-- on for this run, 0 skips it. The server still decides — a client cannot waive a scorecard the
-- skill mandates except by this explicit, recorded per-run choice at run creation.

ALTER TABLE runs ADD COLUMN scorecard_enabled INTEGER;

INSERT INTO schema_version (version, applied_at) VALUES (2, datetime('now'));
