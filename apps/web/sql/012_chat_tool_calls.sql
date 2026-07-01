-- Persist a curator turn's tool-call payload alongside the assistant message it
-- belongs to. Read only by the UI to render the in-chat "feed updated" row; the
-- Claude context uses role + content only, so this column is never sent to the
-- model. Nullable + additive.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS tool_calls jsonb;
