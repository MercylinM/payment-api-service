import { PoolClient } from "pg";
import { pool } from "../db/migrate";
import { Payment, PaymentAttempt, PaymentStatus, VALID_TRANSITIONS } from "../types";

function rowToPayment(row: Record<string, unknown>): Payment {
  return {
    id: row.id as string,
    organisationId: row.organisation_id as string,
    idempotencyKey: row.idempotency_key as string,
    requestHash: row.request_hash as string,
    customerReference: row.customer_reference as string,
    // Amount is stored as BIGINT (minor units). PG returns strings for bigints.
    amount: parseInt(row.amount as string, 10),
    currency: row.currency as string,
    recipientType: row.recipient_type as string,
    recipientValue: row.recipient_value as string,
    description: row.description as string | undefined,
    status: row.status as PaymentStatus,
    providerReference: row.provider_reference as string | undefined,
    failureCode: row.failure_code as string | undefined,
    failureMessage: row.failure_message as string | undefined,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export async function insertOutbox(
  paymentId: string,
  eventType: string,
  payload: object,
  client: PoolClient
): Promise<void> {
  await client.query(
    `INSERT INTO payment_outbox
       (payment_id, event_type, payload, status)
     VALUES ($1,$2,$3,'PENDING')`,
    [paymentId, eventType, JSON.stringify(payload)]
  );
}

export async function findByIdempotencyKey(
  organisationId: string,
  idempotencyKey: string,
  client?: PoolClient
): Promise<Payment | null> {
  const db = client ?? pool;
  const { rows } = await db.query(
    "SELECT * FROM payments WHERE organisation_id = $1 AND idempotency_key = $2",
    [organisationId, idempotencyKey]
  );
  return rows.length ? rowToPayment(rows[0]) : null;
}

export async function findById(id: string): Promise<Payment | null> {
  const { rows } = await pool.query("SELECT * FROM payments WHERE id = $1", [id]);
  return rows.length ? rowToPayment(rows[0]) : null;
}

/**
 * Inserts a new payment inside an existing transaction.
 * The UNIQUE constraint on (organisation_id, idempotency_key) is the
 * database-level guard against concurrent duplicates.
 */
export async function insertPayment(
  payment: Omit<Payment, "id" | "createdAt" | "updatedAt">,
  client: PoolClient
): Promise<Payment> {
  const { rows } = await client.query(
    `INSERT INTO payments
       (organisation_id, idempotency_key, request_hash, customer_reference,
        amount, currency, recipient_type, recipient_value, description, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      payment.organisationId,
      payment.idempotencyKey,
      payment.requestHash,
      payment.customerReference,
      payment.amount,
      payment.currency,
      payment.recipientType,
      payment.recipientValue,
      payment.description ?? null,
      payment.status,
    ]
  );
  return rowToPayment(rows[0]);
}

export async function transitionStatus(
  id: string,
  to: PaymentStatus,
  extra: { providerReference?: string; failureCode?: string; failureMessage?: string } = {},
  client?: PoolClient
): Promise<Payment> {
  const db = client ?? pool;
  const { rows } = await db.query(
    `UPDATE payments
     SET status = $2,
         provider_reference = COALESCE($3, provider_reference),
         failure_code = COALESCE($4, failure_code),
         failure_message = COALESCE($5, failure_message),
         updated_at = NOW()
     WHERE id = $1
       AND status = ANY($6::text[])
     RETURNING *`,
    [
      id,
      to,
      extra.providerReference ?? null,
      extra.failureCode ?? null,
      extra.failureMessage ?? null,
      Object.entries(VALID_TRANSITIONS)
        .filter(([, targets]) => (targets as PaymentStatus[]).includes(to))
        .map(([from]) => from),
    ]
  );
  if (!rows.length) {
    throw new Error(`Invalid status transition to ${to} for payment ${id}`);
  }
  return rowToPayment(rows[0]);
}

export async function insertAttempt(
  attempt: Omit<PaymentAttempt, "id">,
  client?: PoolClient
): Promise<void> {
  const db = client ?? pool;
  await db.query(
    `INSERT INTO payment_attempts
       (payment_id, attempt_number, provider_request_id, status,
        request_payload, response_payload, error_code, error_message,
        started_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      attempt.paymentId,
      attempt.attemptNumber,
      attempt.providerRequestId ?? null,
      attempt.status,
      attempt.requestPayload ? JSON.stringify(attempt.requestPayload) : null,
      attempt.responsePayload ? JSON.stringify(attempt.responsePayload) : null,
      attempt.errorCode ?? null,
      attempt.errorMessage ?? null,
      attempt.startedAt,
      attempt.completedAt ?? null,
    ]
  );
}

export async function countAttempts(paymentId: string, client?: PoolClient): Promise<number> {
  const db = client ?? pool;
  const { rows } = await db.query(
    "SELECT COUNT(*) FROM payment_attempts WHERE payment_id = $1",
    [paymentId]
  );
  return parseInt(rows[0].count, 10);
}

export { pool };
