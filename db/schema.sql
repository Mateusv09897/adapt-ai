CREATE TABLE IF NOT EXISTS adapt_research_events (
  event_id UUID PRIMARY KEY,
  session_id UUID NOT NULL,
  participant_code VARCHAR(32) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  module VARCHAR(80),
  help_level SMALLINT,
  input_length INTEGER,
  with_code BOOLEAN,
  mode VARCHAR(24),
  completed BOOLEAN,
  reason VARCHAR(64),
  duration_seconds INTEGER
);

CREATE INDEX IF NOT EXISTS idx_adapt_events_participant ON adapt_research_events (participant_code);
CREATE INDEX IF NOT EXISTS idx_adapt_events_session ON adapt_research_events (session_id);
CREATE INDEX IF NOT EXISTS idx_adapt_events_occurred ON adapt_research_events (occurred_at);
CREATE INDEX IF NOT EXISTS idx_adapt_events_test ON adapt_research_events (is_test);

-- O Adapt não persiste o texto digitado pelo estudante nesta tabela.
-- Somente eventos estruturados e pseudonimizados são armazenados.
