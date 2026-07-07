-- Outbox table for durable payment processing queue
-- Migration: 20260707000002_create_outbox.sql
-- 
-- This implements the Outbox Pattern:
-- - Payment creation writes both payment AND outbox record atomically
-- - Worker process reads outbox, processes with provider, marks as processed
-- - If app crashes, worker resumes on restart (no lost messages)

CREATE TABLE IF NOT EXISTS payment_outbox (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id          UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  event_type          TEXT NOT NULL,
  payload             JSONB NOT NULL,
  retry_count         INT DEFAULT 0,
  last_error          TEXT,
  last_retry_at       TIMESTAMPTZ,
  processed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT outbox_valid_status CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED')),
  CONSTRAINT outbox_valid_event_type CHECK (event_type IN ('PROCESS_PAYMENT', 'RECONCILE_PAYMENT'))
);

-- Index for worker: find next pending outbox record to process
CREATE INDEX IF NOT EXISTS idx_outbox_pending_created ON payment_outbox(status, created_at)
WHERE status = 'PENDING';

-- Index for monitoring: find failed outbox records
CREATE INDEX IF NOT EXISTS idx_outbox_failed ON payment_outbox(status, last_retry_at)
WHERE status = 'FAILED';

-- Index for cleanup: find old processed records
CREATE INDEX IF NOT EXISTS idx_outbox_processed_created ON payment_outbox(status, processed_at)
WHERE status = 'DONE';
