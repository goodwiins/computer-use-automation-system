CREATE TABLE IF NOT EXISTS meridian_conversations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS meridian_conversations_owner_list
  ON meridian_conversations (owner_id, archived, id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS meridian_conversation_events (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES meridian_conversations (id),
  sequence bigint NOT NULL CHECK (sequence BETWEEN 0 AND 9007199254740991),
  kind text NOT NULL CHECK (kind IN ('message_omitted', 'run_linked')),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  run_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (conversation_id, sequence),
  CHECK (
    (kind = 'run_linked' AND run_id IS NOT NULL)
    OR (kind = 'message_omitted' AND run_id IS NULL)
  )
);
