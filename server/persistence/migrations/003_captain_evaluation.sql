-- The Captain's own evaluation of a draft (overall score + per-criterion rubric scores).
--
-- In a single-writer council there is no peer evaluation, so the Captain — acting as the
-- reviewer — scores the one draft against the rubric. Stored as JSON on the verdict:
--   { "overallScore": <0-100>, "criterionScores": { "<criterionId>": <0-100>, ... } }
-- NULL for multi-writer runs, where the peer-evaluation matrix carries the scores instead.

ALTER TABLE verdicts ADD COLUMN evaluation TEXT;

INSERT INTO schema_version (version, applied_at) VALUES (3, datetime('now'));
