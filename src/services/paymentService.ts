import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { pool } from "../db/migrate";
import * as repo from "../repositories/paymentRepository";
import {
  submitToProvider,
  ProviderRejectionError,
  ProviderTimeoutError,
} from "../provider/client";
import { CreatePaymentRequest, Payment, SUPPORTED_CURRENCIES, SUPPORTED_RECIPIENT_TYPES } from "../types";
import { logger } from "../logger";
import * as metrics from "../metrics";
import { validateAmount, canonicalizeForHashing } from "../utils/amountValidator";

export class ValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("The idempotency key has already been used with a different request");
    this.name = "IdempotencyConflictError";
  }
}

export class PaymentNotFoundError extends Error {
  constructor(id: string) {
    super(`Payment ${id} not found`);
    this.name = "PaymentNotFoundError";
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validate(body: CreatePaymentRequest, idempotencyKey: string): number {
  if (!idempotencyKey) throw new ValidationError("missing_idempotency_key", "Idempotency-Key header is required");
  if (idempotencyKey.length > 128) throw new ValidationError("idempotency_key_too_long", "Idempotency key must be 128 characters or fewer");
  if (!body.organisationId) throw new ValidationError("missing_organisation_id", "organisationId is required");
  if (!body.customerReference) throw new ValidationError("missing_customer_reference", "customerReference is required");
  
  // Validate and convert amount to minor units (cents)
  let amountInMinorUnits: number;
  try {
    amountInMinorUnits = validateAmount(body.amount, body.currency);
  } catch (err) {
    throw new ValidationError("invalid_amount", err instanceof Error ? err.message : String(err));
  }
  
  if (!body.currency) throw new ValidationError("missing_currency", "currency is required");
  if (!SUPPORTED_CURRENCIES.includes(body.currency.toUpperCase())) {
    throw new ValidationError("unsupported_currency", `Currency ${body.currency} is not supported`);
  }
  if (!body.recipient?.type) throw new ValidationError("missing_recipient_type", "recipient.type is required");
  if (!SUPPORTED_RECIPIENT_TYPES.includes(body.recipient.type)) {
    throw new ValidationError("unsupported_recipient_type", `Recipient type ${body.recipient.type} is not supported`);
  }
  if (body.recipient.type === "MOBILE_MONEY" && !body.recipient.phoneNumber) {
    throw new ValidationError("missing_phone_number", "recipient.phoneNumber is required for MOBILE_MONEY");
  }
  
  return amountInMinorUnits;
}

function hashRequest(body: CreatePaymentRequest, amountInMinorUnits: number): string {
  // Deterministic hash using canonicalized fields
  const canonical = canonicalizeForHashing({
    organisationId: body.organisationId,
    customerReference: body.customerReference,
    amount: amountInMinorUnits, // Use minor units (already integer, no precision loss)
    currency: body.currency.toUpperCase(),
    recipientType: body.recipient.type,
    recipientValue: body.recipient.phoneNumber ?? "",
  });
  const canonicalString = JSON.stringify(canonical);
  return createHash("sha256").update(canonicalString).digest("hex");
}

export async function createPayment(
  body: CreatePaymentRequest,
  idempotencyKey: string
): Promise<{ payment: Payment; isReplay: boolean }> {
  const amountInMinorUnits = validate(body, idempotencyKey);

  const requestHash = hashRequest(body, amountInMinorUnits);
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const client = await pool.connect();
    try {
      // Serializable isolation ensures concurrent transactions see each other's
      // inserts and one will fail with a unique-constraint violation.
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");

      // Lock the idempotency slot for this org+key before reading
      // (advisory lock keyed on hash of org+key to avoid table-level locks)
      const lockKey = BigInt("0x" + createHash("md5")
        .update(`${body.organisationId}:${idempotencyKey}`)
        .digest("hex")
        .slice(0, 15));
      await client.query("SELECT pg_advisory_xact_lock($1)", [lockKey.toString()]);

      const existing = await repo.findByIdempotencyKey(body.organisationId, idempotencyKey, client);

      if (existing) {
        await client.query("COMMIT");
        if (existing.requestHash !== requestHash) {
          metrics.idempotencyConflictsTotal.inc();
          logger.warn("idempotency_conflict", { organisationId: body.organisationId });
          throw new IdempotencyConflictError();
        }
        metrics.idempotencyReplaysTotal.inc();
        logger.info("idempotency_replay", { paymentId: existing.id });
        return { payment: existing, isReplay: true };
      }

      const payment = await repo.insertPayment(
        {
          organisationId: body.organisationId,
          idempotencyKey,
          requestHash,
          customerReference: body.customerReference,
          amount: amountInMinorUnits, // Store as minor units (cents)
          currency: body.currency.toUpperCase(),
          recipientType: body.recipient.type,
          recipientValue: body.recipient.phoneNumber ?? "",
          description: body.description,
          status: "PENDING",
        },
        client
      );

      // Insert an outbox record in the same transaction so the payment processing
      // is durable and retriable by a separate worker process.
      // providerRequestId is generated here and stored in the payload so every
      // retry attempt reuses the same ID preventing duplicate provider charges
      // if the provider processed the first attempt but the response was lost.
      const providerRequestId = uuidv4();
      await repo.insertOutbox(payment.id, "PROCESS_PAYMENT", {
        providerRequestId,
        amount: amountInMinorUnits,
        currency: body.currency.toUpperCase(),
        recipient: body.recipient,
      }, client);

      await client.query("COMMIT");

      metrics.paymentsCreatedTotal.inc();
      logger.info("payment_created", { paymentId: payment.id, currency: payment.currency });

      // In test environments, process one outbox item synchronously so tests
      // that expect immediate provider interactions remain deterministic.
      if (process.env.NODE_ENV === "test") {
        try {
          // dynamic import to avoid circular dependencies
          const worker = await import("../worker/processor");
          await worker.processOne();
        } catch (err) {
          logger.error("test_outbox_process_failed", { error: (err as Error).message });
        }
      }

      // Worker will process the outbox in production; no in-memory fire-and-forget required
      return { payment, isReplay: false };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});

      // Retry on PostgreSQL serialization failure
      const isSerializationError = (err as any)?.code === "40001" || (err as Error).message.includes("could not serialize access");
      if (isSerializationError && attempt < maxAttempts) {
        const backoffMs = attempt * 50;
        logger.warn("serialization_conflict_retry", { attempt, backoffMs });
        await new Promise((r) => setTimeout(r, backoffMs));
        continue; // retry
      }

      // If two transactions somehow raced past the advisory lock,
      // the UNIQUE constraint on (organisation_id, idempotency_key)is the final guard.
      // Re-read and treat this exactly like the existing record found, rather than surfacing a raw DB error.
      if ((err as any)?.code === "23505") {
        const existing = await repo.findByIdempotencyKey(body.organisationId, idempotencyKey);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            metrics.idempotencyConflictsTotal.inc();
            logger.warn("idempotency_conflict", { organisationId: body.organisationId });
            throw new IdempotencyConflictError();
          }
          metrics.idempotencyReplaysTotal.inc();
          logger.info("idempotency_replay", { paymentId: existing.id });
          return { payment: existing, isReplay: true };
        }
      }

      throw err;
    } finally {
      client.release();
    }
  }
  throw new Error("Failed to create payment after retries");
}

export async function getPayment(paymentId: string): Promise<Payment> {
  if (!UUID_REGEX.test(paymentId)) {
    throw new ValidationError("invalid_payment_id", "paymentId must be a valid UUID");
  }
  const payment = await repo.findById(paymentId);
  if (!payment) throw new PaymentNotFoundError(paymentId);
  return payment;
}
