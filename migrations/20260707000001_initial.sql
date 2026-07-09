-- Initial schema: payments and payment_attempts tables
-- Migration: 20260707000001_initial.sql

CREATE TABLE IF NOT EXISTS payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   UUID NOT NULL,
  idempotency_key   TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  customer_reference TEXT NOT NULL,
  amount            BIGINT NOT NULL,
  currency          CHAR(3) NOT NULL,
  recipient_type    TEXT NOT NULL,
  recipient_value   TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'PENDING',
  provider_reference TEXT,
  failure_code      TEXT,
  failure_message   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT payments_unique_idempotency UNIQUE (organisation_id, idempotency_key),
  CONSTRAINT payments_positive_amount CHECK (amount > 0),
  CONSTRAINT payments_valid_status CHECK (status IN ('PENDING','PROCESSING','SUCCESS','FAILED'))
);

-- No separate index needed for (organisation_id, idempotency_key): the UNIQUE
-- constraint above already creates a backing btree index on those columns.

CREATE TABLE IF NOT EXISTS payment_attempts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id         UUID NOT NULL REFERENCES payments(id),
  attempt_number     INT NOT NULL,
  provider_request_id UUID,
  status             TEXT NOT NULL,
  request_payload    JSONB,
  response_payload   JSONB,
  error_code         TEXT,
  error_message      TEXT,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_payment_id ON payment_attempts (payment_id);
