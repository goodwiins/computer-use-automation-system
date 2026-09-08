CREATE TABLE IF NOT EXISTS meridian_conversation_subject_quotas (
  owner_id uuid PRIMARY KEY,
  conversation_count bigint NOT NULL DEFAULT 0 CHECK (conversation_count >= 0),
  event_count bigint NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  rate_tokens double precision NOT NULL DEFAULT 20 CHECK (rate_tokens >= 0 AND rate_tokens <= 20),
  rate_refilled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Runtime mutations lock a subject quota row before touching source tables. Hold
-- the table lock first so quota-aware writers drain before source reconciliation.
LOCK TABLE meridian_conversation_subject_quotas IN EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS meridian_conversations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz
);

-- Drain legacy writers before taking the index lock. Lock conversations before
-- events to match the source mutation order and prevent lock-order inversions.
LOCK TABLE meridian_conversations IN EXCLUSIVE MODE;

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

LOCK TABLE meridian_conversation_events IN EXCLUSIVE MODE;

-- Additive local text retention; old metadata-only events stay unchanged.
ALTER TABLE meridian_conversation_events ADD COLUMN IF NOT EXISTS text_ciphertext bytea;
ALTER TABLE meridian_conversation_events DROP CONSTRAINT IF EXISTS meridian_conversation_events_kind_check;
ALTER TABLE meridian_conversation_events DROP CONSTRAINT IF EXISTS meridian_conversation_events_check;
ALTER TABLE meridian_conversation_events ADD CONSTRAINT meridian_conversation_events_kind_check
  CHECK (kind IN ('message_omitted', 'run_linked', 'message_saved'));
ALTER TABLE meridian_conversation_events ADD CONSTRAINT meridian_conversation_events_check CHECK (
  (kind = 'run_linked' AND run_id IS NOT NULL AND text_ciphertext IS NULL)
  OR (kind = 'message_omitted' AND run_id IS NULL AND text_ciphertext IS NULL)
  OR (kind = 'message_saved' AND run_id IS NULL AND text_ciphertext IS NOT NULL
      AND octet_length(text_ciphertext) BETWEEN 29 AND 16028)
);


INSERT INTO meridian_conversation_subject_quotas (owner_id, conversation_count, event_count)
SELECT conversations.owner_id, count(DISTINCT conversations.id)::bigint, count(events.id)::bigint
FROM meridian_conversations conversations
LEFT JOIN meridian_conversation_events events ON events.conversation_id = conversations.id
GROUP BY conversations.owner_id
ON CONFLICT (owner_id) DO UPDATE
SET conversation_count = EXCLUDED.conversation_count,
    event_count = EXCLUDED.event_count;
