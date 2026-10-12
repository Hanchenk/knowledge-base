CREATE TABLE IF NOT EXISTS bot_messages (
    task_id TEXT NOT NULL REFERENCES bot_tasks(id),
    id TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (task_id, id)
);
CREATE INDEX IF NOT EXISTS ix_bot_messages_task ON bot_messages(task_id, created_at, id);
