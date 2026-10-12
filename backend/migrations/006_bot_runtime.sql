CREATE TABLE IF NOT EXISTS bot_runtime (
    task_id TEXT PRIMARY KEY REFERENCES bot_tasks(id),
    encrypted_state TEXT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_tool_calls (
    task_id TEXT NOT NULL REFERENCES bot_tasks(id), call_id TEXT NOT NULL,
    name TEXT NOT NULL, encrypted_call TEXT NOT NULL, encrypted_result TEXT,
    status TEXT NOT NULL, updated_at BIGINT NOT NULL,
    PRIMARY KEY(task_id,call_id)
);
CREATE INDEX IF NOT EXISTS ix_bot_tool_calls_history ON bot_tool_calls(task_id,updated_at);
