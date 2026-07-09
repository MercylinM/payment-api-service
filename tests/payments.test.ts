import request from "supertest";
import { app } from "../src/app";
import { setupDb, cleanDb, teardownDb, validPayload, testPool } from "./helpers";
import { v4 as uuidv4 } from "uuid";
import nock from "nock";

// We test against the real DB; provider calls are intercepted with nock
const PROVIDER_URL = process.env.PROVIDER_URL || "http://localhost:4000";

beforeAll(async () => {
  await setupDb();
});

beforeEach(async () => {
  await cleanDb();
  nock.cleanAll();
});

afterAll(async () => {
  await teardownDb();
  nock.restore();
});

function mockProviderSuccess() {
  nock(PROVIDER_URL)
    .post("/provider/payments")
    .reply(200, { providerReference: "PROV-1234567", status: "SUCCESS" });
}

function mockProviderReject() {
  nock(PROVIDER_URL)
    .post("/provider/payments")
    .reply(422, { error: "payment_rejected", message: "Recipient account not found" });
}

function mockProviderTimeout() {
  nock(PROVIDER_URL)
    .post("/provider/payments")
    .replyWithError({ code: "ECONNABORTED", message: "timeout" });
}

// ── Scenario 1: Normal successful payment ────────────────────────────────────
describe("POST /api/v1/payments", () => {
  it("creates a payment and returns 201", async () => {
    mockProviderSuccess();
    const key = uuidv4();
    const res = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.paymentId).toBeDefined();
    expect(res.body.status).toBe("PENDING");
    expect(res.body.amount).toBe(1500);
    expect(res.body.currency).toBe("KES");
  });

  // ── Validation ──────────────────────────────────────────────────────────────
  it("rejects missing Idempotency-Key header", async () => {
    const res = await request(app).post("/api/v1/payments").send(validPayload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_idempotency_key");
  });

  it("rejects invalid amount (zero)", async () => {
    const res = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", uuidv4())
      .send({ ...validPayload, amount: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_amount");
  });

  it("rejects negative amount", async () => {
    const res = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", uuidv4())
      .send({ ...validPayload, amount: -100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_amount");
  });

  it("rejects unsupported currency", async () => {
    const res = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", uuidv4())
      .send({ ...validPayload, currency: "XYZ" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_currency");
  });

  it("rejects missing phone number for MOBILE_MONEY", async () => {
    const res = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", uuidv4())
      .send({ ...validPayload, recipient: { type: "MOBILE_MONEY" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_phone_number");
  });

  // ── Scenario 2: Idempotent replay ───────────────────────────────────────────
  it("returns existing payment on same key + same body (no second provider call)", async () => {
    mockProviderSuccess();
    const key = uuidv4();

    const first = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send(validPayload);
    expect(first.status).toBe(201);

    // nock would throw if provider is called again (no second mock registered)
    const second = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send(validPayload);
    expect(second.status).toBe(200);
    expect(second.body.paymentId).toBe(first.body.paymentId);
  });

  // ── Scenario 4: Idempotency conflict ────────────────────────────────────────
  it("rejects same key with different request body", async () => {
    mockProviderSuccess();
    const key = uuidv4();

    await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send(validPayload);

    const res = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send({ ...validPayload, amount: 5000 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("idempotency_key_reused");
  });

  // ── Different organisations share the same key ───────────────────────────────
  it("allows same idempotency key for different organisations", async () => {
    mockProviderSuccess();
    mockProviderSuccess();
    const key = uuidv4();
    const orgA = uuidv4();
    const orgB = uuidv4();

    const resA = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send({ ...validPayload, organisationId: orgA });

    const resB = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send({ ...validPayload, organisationId: orgB });

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resA.body.paymentId).not.toBe(resB.body.paymentId);
  });

  // ── Scenario 5: Provider rejection ──────────────────────────────────────────
  it("records FAILED status when provider rejects", async () => {
    mockProviderReject();
    const key = uuidv4();

    const res = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send(validPayload);

    expect(res.status).toBe(201);

    // Give async processing time to complete
    await new Promise(r => setTimeout(r, 500));

    const { rows } = await testPool.query("SELECT status FROM payments WHERE id = $1", [res.body.paymentId]);
    expect(rows[0].status).toBe("FAILED");
  });

  // ── Scenario 6: Provider timeout ────────────────────────────────────────────
  it("leaves payment in PROCESSING when provider times out", async () => {
    mockProviderTimeout();
    const key = uuidv4();

    const res = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send(validPayload);

    expect(res.status).toBe(201);

    // Wait for timeout to fire (PROVIDER_TIMEOUT_MS defaults to 5s in tests — override)
    await new Promise(r => setTimeout(r, 1000));

    const { rows } = await testPool.query("SELECT status FROM payments WHERE id = $1", [res.body.paymentId]);
    // Status must be PROCESSING — the worker picked it up and transitioned it
    // before the provider timed out. PENDING would mean the worker never ran.
    expect(rows[0].status).toBe("PROCESSING");
  });
});

// ── GET /api/v1/payments/:id ─────────────────────────────────────────────────
describe("GET /api/v1/payments/:paymentId", () => {
  it("returns payment details", async () => {
    mockProviderSuccess();
    const key = uuidv4();
    const created = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send(validPayload);

    const res = await request(app).get(`/api/v1/payments/${created.body.paymentId}`);
    expect(res.status).toBe(200);
    expect(res.body.paymentId).toBe(created.body.paymentId);
    expect(res.body.organisationId).toBe(validPayload.organisationId);
  });

  it("returns 404 for unknown payment", async () => {
    const res = await request(app).get(`/api/v1/payments/${uuidv4()}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("payment_not_found");
  });
});

// ── Scenario 3: Real concurrency test ───────────────────────────────────────
describe("Concurrency", () => {
  it("creates exactly one payment when two identical requests race", async () => {
    // Register enough provider mocks for potential multiple calls
    mockProviderSuccess();
    mockProviderSuccess();

    const key = uuidv4();
    const payload = { ...validPayload, organisationId: uuidv4() };

    const [r1, r2] = await Promise.all([
      request(app).post("/api/v1/payments").set("Idempotency-Key", key).send(payload),
      request(app).post("/api/v1/payments").set("Idempotency-Key", key).send(payload),
    ]);

    // Both must succeed (one 201, one 200 replay — or both 200/201)
    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);

    // Both must return the same paymentId
    expect(r1.body.paymentId).toBe(r2.body.paymentId);

    // Exactly one row in the DB
    const { rows } = await testPool.query(
      "SELECT COUNT(*) FROM payments WHERE organisation_id = $1 AND idempotency_key = $2",
      [payload.organisationId, key]
    );
    expect(parseInt(rows[0].count, 10)).toBe(1);
  });

  it("multiple clients can retrieve the same payment simultaneously", async () => {
    mockProviderSuccess();
    const key = uuidv4();

    const create = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send(validPayload);

    expect(create.status).toBe(201);

    const [get1, get2, get3] = await Promise.all([
      request(app).get(`/api/v1/payments/${create.body.paymentId}`),
      request(app).get(`/api/v1/payments/${create.body.paymentId}`),
      request(app).get(`/api/v1/payments/${create.body.paymentId}`),
    ]);

    expect(get1.status).toBe(200);
    expect(get2.status).toBe(200);
    expect(get3.status).toBe(200);
    expect(get1.body.paymentId).toBe(get2.body.paymentId);
    expect(get2.body.paymentId).toBe(get3.body.paymentId);
  });
});

// ── Additional validation tests ──────────────────────────────────────────────
describe("Validation", () => {
  it("rejects idempotency key longer than 128 characters", async () => {
    const longKey = "a".repeat(129);
    const res = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", longKey)
      .send(validPayload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("idempotency_key_too_long");
  });

  it("accepts idempotency key of exactly 128 characters", async () => {
    mockProviderSuccess();
    const key = "a".repeat(128);
    const res = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send(validPayload);
    expect(res.status).toBe(201);
  });

  it("rejects unsupported recipient type", async () => {
    const res = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", uuidv4())
      .send({
        ...validPayload,
        recipient: { type: "BANK_TRANSFER", accountNumber: "123456" },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_recipient_type");
  });

  it("supports multiple currencies", async () => {
    mockProviderSuccess();
    mockProviderSuccess();
    mockProviderSuccess();

    const currencies = ["USD", "EUR", "GBP"];

    for (const currency of currencies) {
      const res = await request(app)
        .post("/api/v1/payments")
        .set("Idempotency-Key", uuidv4())
        .send({ ...validPayload, currency });
      expect(res.status).toBe(201);
      expect(res.body.currency).toBe(currency);
    }
  });
});

// ── Scenario 7: Provider processes payment but response is lost ──────────────
describe("Scenario 7: Provider Success + Timeout", () => {
  it("with timeout, retrying with same key does not create second provider payment", async () => {
    mockProviderTimeout();
    const key = uuidv4();

    // First request times out
    const res1 = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send(validPayload);

    expect(res1.status).toBe(201);
    expect(res1.body.status).toBe("PENDING");

    // Wait for async processing and timeout
    await new Promise(r => setTimeout(r, 1000));

    // Payment should be in PROCESSING (uncertain state — provider outcome unknown)
    let paymentAfterTimeout = await request(app).get(`/api/v1/payments/${res1.body.paymentId}`);
    expect(paymentAfterTimeout.body.status).toBe("PROCESSING");

    // Client retries with the same idempotency key
    // No new provider mock is registered, so if a second provider call is made, nock will throw
    const res2 = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send(validPayload);

    // Should be returned by idempotency layer (no second provider call)
    expect([200, 201]).toContain(res2.status);
    expect(res2.body.paymentId).toBe(res1.body.paymentId);
  });
});

// ── Response format tests ────────────────────────────────────────────────────
describe("Response Format", () => {
  it("includes optional fields (description, failure codes) in GET response", async () => {
    mockProviderReject();
    const key = uuidv4();

    const created = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send({ ...validPayload, description: "Test payment" });

    expect(created.status).toBe(201);
    expect(created.body.description).toBe("Test payment");

    // Wait for async processing to complete
    await new Promise(r => setTimeout(r, 500));

    const res = await request(app).get(`/api/v1/payments/${created.body.paymentId}`);
    expect(res.status).toBe(200);
    expect(res.body.description).toBe("Test payment");
    expect(res.body.failureCode).toBeDefined();
    expect(res.body.failureMessage).toBeDefined();
  });

  it("omits null/undefined optional fields from response", async () => {
    mockProviderSuccess();
    const key = uuidv4();
    
    // Create payload without description
    const { description, ...payloadWithoutDescription } = validPayload;

    const created = await request(app)
      .post("/api/v1/payments")
      .set("Idempotency-Key", key)
      .send(payloadWithoutDescription);

    // Wait for async processing
    await new Promise(r => setTimeout(r, 500));

    const res = await request(app).get(`/api/v1/payments/${created.body.paymentId}`);
    expect(res.status).toBe(200);
    expect(res.body.description).toBeUndefined();
    expect(res.body.failureCode).toBeUndefined();
    expect(res.body.failureMessage).toBeUndefined();
  });
});

// ── Health and observability endpoints ───────────────────────────────────────
describe("Health and Observability", () => {
  it("returns healthy status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("exposes Prometheus metrics", async () => {
    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.text).toContain("payments_created_total");
    expect(res.text).toContain("payments_success_total");
    expect(res.text).toContain("payments_failed_total");
    expect(res.text).toContain("provider_requests_total");
    expect(res.text).toContain("provider_timeouts_total");
  });
});
