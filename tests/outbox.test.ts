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
});

test("outbox worker processes a pending payment and marks it SUCCESS", async () => {
  // Mock provider to accept the request
  const provider = nock(process.env.PROVIDER_URL || "http://localhost:4000")
    .post("/provider/payments")
    .reply(200, { providerReference: "PROV-12345", status: "SUCCESS" });

  const idempotencyKey = "test-key-1";
  const { payment } = await service.createPayment(validPayload as any, idempotencyKey);

  // Ensure outbox record exists (may be processed immediately in test env)
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
