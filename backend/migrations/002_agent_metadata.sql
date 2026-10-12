CREATE TABLE IF NOT EXISTS agent_message_metadata (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    engine TEXT NOT NULL,
    web_sources TEXT NOT NULL DEFAULT '[]',
    tool_calls TEXT NOT NULL DEFAULT '[]'
);
