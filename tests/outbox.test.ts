import nock from "nock";
import { setupDb, cleanDb, teardownDb, testPool, validPayload } from "./helpers";
import * as service from "../src/services/paymentService";
import * as repo from "../src/repositories/paymentRepository";
import worker from "../src/worker/processor";

beforeAll(async () => {
  await setupDb();
});

afterAll(async () => {
  await teardownDb();
});

beforeEach(async () => {
  await testPool.query("TRUNCATE payment_attempts, payment_outbox, payments CASCADE");
  nock.cleanAll();
});

test("worker retries a timed-out outbox record using the same providerRequestId, then succeeds without a duplicate provider payment", async () => {
  // First attempt: the provider call times out from the worker's point of
  // view (connection dropped), simulating the "provider processed the
  // payment but the response was lost" scenario. We capture the
  // requestId it was sent so we can assert the retry reuses it unchanged.
  let firstRequestId: string | undefined;
  const timeoutCall = nock(process.env.PROVIDER_URL || "http://localhost:4000")
    .post("/provider/payments", (body) => {
      firstRequestId = body.requestId;
      return true;
    })
    .replyWithError({ code: "ECONNABORTED" });

  const idempotencyKey = "test-key-worker-retry";
  const { payment } = await service.createPayment(validPayload as any, idempotencyKey);
  timeoutCall.done();

  // The synchronous test-env processing hit the timeout: outbox should be
  // back in PENDING with retry_count = 1, payment left in PROCESSING.
  let { rows } = await testPool.query("SELECT * FROM payment_outbox WHERE payment_id = $1", [payment.id]);
  expect(rows[0].status).toBe("PENDING");
  expect(rows[0].retry_count).toBe(1);

  let afterTimeout = await repo.findById(payment.id);
  expect(afterTimeout!.status).toBe("PROCESSING");
  expect(firstRequestId).toBeDefined();

  // Second attempt (the worker's own retry, not a client retry): this time
  // the provider actually responds, but the assertion function on the nock
  // interceptor is what proves the worker sent the SAME requestId as before,
  // exactly as a real provider's dedup logic would require to avoid a second
  // charge.
  let secondRequestId: string | undefined;
  const retryCall = nock(process.env.PROVIDER_URL || "http://localhost:4000")
    .post("/provider/payments", (body) => {
      secondRequestId = body.requestId;
      return true;
    })
    .reply(200, { providerReference: "PROV-RETRY-1", status: "SUCCESS" });

  const processed = await (worker as any).processOne();
  expect(processed).toBe(true);
  retryCall.done();

  expect(secondRequestId).toBe(firstRequestId);

  const final = await repo.findById(payment.id);
  expect(final!.status).toBe("SUCCESS");
  expect(final!.providerReference).toBe("PROV-RETRY-1");

  // Only the successful attempt is recorded, so there must be
  // exactly one provider-facing attempt on record, not two.
  const attemptCount = await repo.countAttempts(payment.id);
  expect(attemptCount).toBe(1);
});

test("outbox worker processes a pending payment and marks it SUCCESS", async () => {
  // Mock provider to accept the request
  const provider = nock(process.env.PROVIDER_URL || "http://localhost:4000")
    .post("/provider/payments")
    .reply(200, { providerReference: "PROV-12345", status: "SUCCESS" });

  const idempotencyKey = "test-key-1";
  const { payment } = await service.createPayment(validPayload as any, idempotencyKey);

  // Ensure outbox record exists 
  const { rows } = await testPool.query("SELECT * FROM payment_outbox WHERE payment_id = $1", [payment.id]);
  expect(rows.length).toBe(1);
  expect(["PENDING", "DONE"]).toContain(rows[0].status);

  // Process one outbox item if it hasn't already been processed synchronously
  if (rows[0].status === "PENDING") {
    const processed = await (worker as any).processOne();
    expect(processed).toBe(true);
  }

  // Payment should be SUCCESS
  const updated = await repo.findById(payment.id);
  expect(updated).not.toBeNull();
  expect(updated!.status).toBe("SUCCESS");

  // Outbox should be marked DONE
  const { rows: outRows } = await testPool.query("SELECT * FROM payment_outbox WHERE payment_id = $1", [payment.id]);
  expect(outRows.length).toBe(1);
  expect(outRows[0].status).toBe("DONE");

  provider.done();
});
