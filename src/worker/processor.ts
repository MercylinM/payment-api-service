import { pool } from "../db/migrate";
import { submitToProvider, ProviderRejectionError, ProviderTimeoutError } from "../provider/client";
import * as repo from "../repositories/paymentRepository";
import { logger } from "../logger";
import * as metrics from "../metrics";

const POLL_INTERVAL_MS = parseInt(process.env.OUTBOX_POLL_MS || "1000", 10);
const MAX_RETRIES = 5;

async function processNext(): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Fetch one pending outbox record and lock it
    const { rows } = await client.query(
      `SELECT id, payment_id, event_type, payload, retry_count
       FROM payment_outbox
       WHERE status = 'PENDING'
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`
    );

    if (!rows.length) {
      await client.query("COMMIT");
      return false; // nothing to do
    }

    const outbox = rows[0];

    // Mark as processing
    await client.query(
      `UPDATE payment_outbox SET status = 'PROCESSING', updated_at = NOW() WHERE id = $1`,
      [outbox.id]
    );

    // Parse payload
    const payload = outbox.payload as any;

    // Transition payment to PROCESSING before calling provider
    try {
      await repo.transitionStatus(outbox.payment_id, "PROCESSING", {}, client);
    } catch (e) {
      // If transition fails, mark outbox as FAILED and bail
      await client.query(`UPDATE payment_outbox SET status='FAILED', last_error = $1, updated_at = NOW() WHERE id = $2`, [(e as Error).message, outbox.id]);
      await client.query("COMMIT");
      logger.error("outbox_invalid_transition", { outboxId: outbox.id, paymentId: outbox.payment_id, error: (e as Error).message });
      return true;
    }

    // providerRequestId is fixed at payment creation time and stored in the
    // outbox payload. Reusing it on every retry means the provider can deduplicate
    // on its side — preventing a double charge if the first attempt succeeded
    // but the response was lost (Scenario 7).
    const providerRequestId: string = payload.providerRequestId;
    if (!providerRequestId) {
      throw new Error(`outbox record ${outbox.id} is missing providerRequestId in payload`);
    }
    const amountMinor: number = payload.amount; // minor units
    const amountMajor = Number((amountMinor / 100).toFixed(2));
    const currency = payload.currency;
    const recipient = payload.recipient?.phoneNumber ?? payload.recipient;

    metrics.providerRequestsTotal.inc();

    try {
      const providerResp = await submitToProvider({
        requestId: providerRequestId,
        amount: amountMajor,
        currency,
        recipient,
      });

      // Insert attempt
      await repo.insertAttempt(
        {
          paymentId: outbox.payment_id,
          attemptNumber: (outbox.retry_count ?? 0) + 1,
          providerRequestId,
          status: "SUCCESS",
          requestPayload: { requestId: providerRequestId, amount: amountMajor, currency, recipient },
          responsePayload: providerResp,
          startedAt: new Date(),
          completedAt: new Date(),
        },
        client
      );

      // Transition payment to SUCCESS
      await repo.transitionStatus(outbox.payment_id, "SUCCESS", { providerReference: providerResp.providerReference }, client);

      // Mark outbox done
      await client.query(`UPDATE payment_outbox SET status='DONE', processed_at = NOW(), updated_at = NOW() WHERE id = $1`, [outbox.id]);

      metrics.paymentsSuccessTotal.inc();
      logger.info("outbox_processed_success", { outboxId: outbox.id, paymentId: outbox.payment_id });
    } catch (err) {
      if (err instanceof ProviderRejectionError) {
        // Provider rejected — mark payment as FAILED and outbox DONE
        await repo.insertAttempt(
          {
            paymentId: outbox.payment_id,
            attemptNumber: (outbox.retry_count ?? 0) + 1,
            providerRequestId,
            status: "FAILED",
            requestPayload: { requestId: providerRequestId, amount: amountMajor, currency, recipient },
            errorCode: err.code,
            errorMessage: err.message,
            startedAt: new Date(),
            completedAt: new Date(),
          },
          client
        );

        await repo.transitionStatus(outbox.payment_id, "FAILED", { failureCode: err.code, failureMessage: err.message }, client);
        await client.query(`UPDATE payment_outbox SET status='DONE', processed_at = NOW(), updated_at = NOW() WHERE id = $1`, [outbox.id]);
        metrics.paymentsFailedTotal.inc();
        logger.info("outbox_processed_rejected", { outboxId: outbox.id, paymentId: outbox.payment_id });
      } else if (err instanceof ProviderTimeoutError) {
        // Provider timeout — schedule retry
        const retries = (outbox.retry_count ?? 0) + 1;
        const newStatus = retries > MAX_RETRIES ? 'FAILED' : 'PENDING';
        await client.query(
          `UPDATE payment_outbox SET retry_count = $1, last_error = $2, last_retry_at = NOW(), status = $3, updated_at = NOW() WHERE id = $4`,
          [retries, 'provider_timeout', newStatus, outbox.id]
        );
        metrics.providerTimeoutsTotal.inc();
        logger.warn("outbox_provider_timeout", { outboxId: outbox.id, paymentId: outbox.payment_id, retries });
      } else {
        // Internal error — schedule retry
        const retries = (outbox.retry_count ?? 0) + 1;
        const newStatus = retries > MAX_RETRIES ? 'FAILED' : 'PENDING';
        await client.query(
          `UPDATE payment_outbox SET retry_count = $1, last_error = $2, last_retry_at = NOW(), status = $3, updated_at = NOW() WHERE id = $4`,
          [retries, (err as Error).message, newStatus, outbox.id]
        );
        logger.error("outbox_processing_error", { outboxId: outbox.id, paymentId: outbox.payment_id, error: (err as Error).message });
      }
    }

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error("outbox_worker_error", { error: (err as Error).message });
    return false;
  } finally {
    client.release();
  }
}

async function runLoop() {
  logger.info("outbox_worker_started");
  while (true) {
    try {
      const didWork = await processNext();
      if (!didWork) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (err) {
      logger.error("outbox_worker_runtime_error", { error: (err as Error).message });
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

if (require.main === module) {
  runLoop().catch((err) => {
    logger.error("outbox_worker_fatal", { error: (err as Error).message });
    process.exit(1);
  });
}

export async function processOne(): Promise<boolean> {
  return processNext();
}

export default { runLoop, processOne };
