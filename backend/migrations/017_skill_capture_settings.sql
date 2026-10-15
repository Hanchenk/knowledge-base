-- Applied once under the migration transaction's settings-column guard.
-- Existing users keep the previously available skill proposal behavior.
ALTER TABLE bot_memory_settings ADD COLUMN skill_capture INTEGER NOT NULL DEFAULT 1 CHECK(skill_capture IN (0,1));
