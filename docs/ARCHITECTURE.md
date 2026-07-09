# Architecture

## System Overview

The Payment API Service handles financial transactions with guarantees around idempotency, concurrency safety, and transparent status tracking. The core design goal is to ensure a payment is created exactly once and processed exactly once, even under retries, concurrent requests, and unreliable provider responses.

### High-Level Flow

```
Client
  |
  ├── POST /api/v1/payments ---------> Validation
                                           |
                                    Idempotency check
                                    (advisory lock + SERIALIZABLE tx)
                                           |
                                    ├──----├──----+
                                    |             |
                                 Duplicate     New payment
                                    |             |
                                200 / 409     INSERT payment (PENDING)
                                              INSERT outbox record
                                              COMMIT
                                              201 Created
  |
  └── GET /api/v1/payments/:id ------> Return current payment status


Outbox Worker (background)
  |
  Poll payment_outbox for PENDING records (FOR UPDATE SKIP LOCKED)
  |
  Transition payment to PROCESSING
  |
  Call provider
  |
  ├── Success  --> payment = SUCCESS,    outbox = DONE
  ├── Rejected --> payment = FAILED,     outbox = DONE
  ├── Timeout  --> payment = PROCESSING, outbox retried (same providerRequestId)
  └── Max retries exceeded --> outbox = FAILED (dead-letter)
```

---

## Core Design Principles

### 1. Idempotency at the Database Level

**Problem**: Financial transactions must be idempotent. If a client retransmits the same request due to a network timeout, it must get the same result without creating duplicate charges.

**Approach**: A unique constraint on the combination of `organisation_id` and `idempotency_key` in the payments table is the primary guard. No application-level check alone can prevent duplicates under concurrency — the database enforces it unconditionally, regardless of how many application replicas are running.

When a replay request arrives, the service computes a SHA-256 hash of the semantically significant request fields and compares it to the stored hash. If the hashes match, the existing payment is returned. If they differ, the request is rejected with a 409 — the same key cannot be reused for a different payment.

The uniqueness boundary includes `organisation_id` so different organisations can reuse the same idempotency key independently without conflict.

### 2. Concurrency Control via Advisory Locks

**Problem**: Two concurrent requests with the same idempotency key could both pass the existence check before either has committed the insert, resulting in two payments being created.

**Approach**: Before reading the payments table, the service acquires a PostgreSQL advisory transaction lock keyed on a hash of the `organisation_id` and `idempotency_key`. This serialises all operations on a given key pair within a SERIALIZABLE transaction. The lock is scoped to the transaction and released automatically on commit or rollback — no manual cleanup is needed.

The unique constraint acts as a hard backstop: if two transactions somehow race past the advisory lock, only one insert will succeed. The other receives a unique-violation error, which the service handles by re-reading and returning the existing payment. This two-layer defence means the system is safe even in edge cases where the advisory lock does not fully serialise access.

Both the lock and the constraint live in the shared database, so this works correctly across any number of application replicas.

### 3. SERIALIZABLE Isolation

**Problem**: READ COMMITTED isolation allows phantom reads — a transaction can miss a row inserted by a concurrent transaction between two reads within the same transaction.

**Approach**: Each idempotency check runs inside a SERIALIZABLE transaction. This is the strongest isolation level PostgreSQL offers and ensures the read-then-insert sequence is atomic with respect to all concurrent transactions. PostgreSQL implements SERIALIZABLE efficiently using predicate locking rather than blocking every row, so the performance cost is lower than it might appear.

When two SERIALIZABLE transactions conflict, PostgreSQL aborts one with a serialization failure error. The service catches this and retries the entire operation up to three times with linear backoff before propagating the error to the caller.

### 4. Outbox Pattern for Durable Processing

**Problem**: If the API calls the provider synchronously, a crash between the provider call and the status update leaves the payment in an unknown state with no record of what happened. Fire-and-forget async processing has the same problem — if the process restarts, the in-flight work is silently lost.

**Approach**: Payment creation writes both the payment row and an outbox record in the same SERIALIZABLE transaction. Either both are committed or neither is — there is no window where a payment exists without a corresponding processing instruction.

A separate worker process polls the outbox table and processes each record to completion within its own transaction. If the worker crashes mid-flight, the outbox record is still in `PROCESSING` status and will be picked up again on restart. The worker uses `FOR UPDATE SKIP LOCKED` when selecting outbox records, which means multiple worker instances can run in parallel safely — each will claim a different record and no record will be processed twice.

### 5. Fixed providerRequestId

**Problem**: If the worker generates a new provider request identifier on each retry, a provider that processed the first attempt but dropped the response will treat the retry as a new payment and charge again. This is the most dangerous failure mode in payment systems.

**Approach**: A `providerRequestId` is generated once at payment creation time and stored inside the outbox payload as part of the same atomic transaction that creates the payment. Every time the worker processes or retries that outbox record, it reads this fixed identifier from the payload and sends it to the provider unchanged.

This means the provider receives the same identifier on every attempt and can safely deduplicate on its side. Even in the scenario where the provider processed the payment but the response was lost in transit, a retry will not result in a second charge.

### 6. Amount Storage in Minor Units

**Problem**: Floating-point arithmetic is unsafe for monetary values. Representing `1500.00` as a floating-point number introduces precision errors that compound across calculations.

**Approach**: Amounts are converted to integer minor units (cents) at the validation boundary using the `decimal.js` library, which performs exact decimal arithmetic. The integer value is stored as a `BIGINT` in the database. Conversion back to major units for the HTTP response happens only at the serialization boundary. No floating-point arithmetic touches monetary values anywhere in the processing pipeline.

This also makes the request hash deterministic — `1500`, `1500.0`, and `1500.00` all convert to the same integer `150000`, so they produce the same hash and are correctly treated as the same payment.

### 7. Status Transitions Enforced at the Database Level

**Problem**: Application-level status checks can be bypassed or race with concurrent updates, allowing a payment to move into an invalid state.

**Approach**: Status transitions are enforced by the update query itself. The `WHERE` clause includes a condition that the current status must be one of the valid source statuses for the target transition. If the payment is not in a valid source status, zero rows are updated and the service raises an error. This makes invalid transitions impossible regardless of application logic or concurrency.

Valid transitions are:

```
PENDING    -> PROCESSING
PROCESSING -> PROCESSING (worker retry: payment already in PROCESSING from a prior attempt)
PROCESSING -> SUCCESS
PROCESSING -> FAILED
```

Terminal statuses (`SUCCESS` and `FAILED`) have no valid outgoing transitions, so a payment that has reached a final state cannot be moved backwards.

---

## Request Lifecycle

### Validation

Every incoming request is validated before any database interaction. The service checks that all required fields are present, that the amount is positive with at most two decimal places, that the currency is one of the supported codes, and that the recipient type and phone number are consistent. The idempotency key must be present and no longer than 128 characters. Any validation failure returns a 400 with a structured error body and no database write occurs.

### Idempotency Check and Payment Creation

Once validation passes, the service acquires an advisory lock on the `(organisation_id, idempotency_key)` pair and opens a SERIALIZABLE transaction. It queries the payments table for an existing record with that key.

If a record is found, the request hash is compared. A matching hash returns the existing payment. A mismatched hash returns a 409 conflict. In both cases the transaction is committed and the lock released.

If no record is found, the service inserts the payment row in `PENDING` status and an outbox record in the same transaction. The `providerRequestId` is generated at this point and stored in the outbox payload. The transaction is committed and a 201 response is returned immediately. The caller does not wait for the provider.

### Outbox Worker Processing

The worker runs a continuous poll loop. On each iteration it selects one `PENDING` outbox record using `FOR UPDATE SKIP LOCKED`, which atomically claims the record and prevents any other worker instance from picking it up.

The worker transitions the payment to `PROCESSING`, then calls the provider using the `providerRequestId` from the outbox payload. All state changes — the payment status update, the attempt record, and the outbox status update — are committed in a single transaction so they are always consistent.

On a successful provider response the payment moves to `SUCCESS` and the outbox record is marked `DONE`. On a business rejection the payment moves to `FAILED` and the outbox is marked `DONE`. On a timeout or transient error the outbox retry count is incremented and the record is reset to `PENDING` for the next poll cycle. The payment remains in `PROCESSING` because the outcome is genuinely unknown. Once the retry count exceeds five attempts, the outbox record is marked `FAILED` and requires manual reconciliation. The payment itself remains in `PROCESSING`, it is not automatically moved to `FAILED` because the provider outcome is still unknown and a human or reconciliation job must determine the correct resolution.

---

## Technology Choices

### Node.js + TypeScript

Type safety is valuable in financial code — incorrect types on amount fields or status values are caught at compile time rather than in production. TypeScript's strict mode is enabled throughout the codebase.

### Express.js

Lightweight and explicit. The thin HTTP layer makes it straightforward to reason about what happens at each request boundary without framework magic obscuring the flow.

### PostgreSQL 16

The entire concurrency and idempotency strategy depends on database-level primitives: advisory locks, SERIALIZABLE isolation, unique constraints, and `FOR UPDATE SKIP LOCKED`. PostgreSQL provides all of these reliably and is well understood in production payment systems. Storing amounts as `BIGINT` avoids any numeric precision issues at the storage layer.

### decimal.js

Used exclusively at the validation and serialization boundary to convert between major and minor units without floating-point error. No floating-point arithmetic touches monetary values anywhere else in the codebase.

### Jest + Supertest + Nock

Jest runs integration tests against a real PostgreSQL instance rather than mocks, which means the idempotency and concurrency guarantees are verified against actual database behaviour. Supertest drives the HTTP layer end-to-end. Nock intercepts provider HTTP calls at the socket level, allowing timeout and rejection scenarios to be tested deterministically without a live provider.

---

## Data Model

Three tables store all payment state.

The **payments** table is the source of truth for payment identity and status. It holds the idempotency key, the request hash used for conflict detection, the amount in minor units, and the current status. The unique constraint on `(organisation_id, idempotency_key)` is the database-level idempotency guard. A check constraint on `status` ensures only valid status values can be stored.

The **payment_attempts** table is an append-only audit log. Every provider call — successful, rejected, or timed out — produces one row. Each row records the `providerRequestId` sent, the request and response payloads, and the outcome. This table is the primary tool for reconciling payments whose outcome is uncertain.

The **payment_outbox** table is the durable processing queue. Each row represents one pending or in-progress provider call. The `payload` column stores the fixed `providerRequestId` alongside the payment details needed to construct the provider request. The `retry_count` and `last_error` columns track the processing history. A partial index on `status = 'PENDING'` keeps the worker's poll query fast.

---

## Error Handling

| Scenario | HTTP status | Payment status | Notes |
|----------|-------------|----------------|-------|
| Validation failure | 400 | — | No database write |
| Missing idempotency key | 400 | — | |
| Idempotency conflict | 409 | unchanged | Same key, different body |
| Payment not found | 404 | — | |
| Provider rejection | — | FAILED | Business rejection recorded with failure code |
| Provider timeout | — | PROCESSING | Outcome unknown, outbox retried |
| Provider 500 | — | PROCESSING | Treated as transient, outbox retried |
| Max retries exceeded | — | PROCESSING | Outbox marked FAILED, payment stays PROCESSING; the outcome is unknown,so manual reconciliation is required |
| Internal error | 500 | — | No stack trace returned to client |

---

## Observability

The service exposes a health check endpoint that returns a simple status object, used by load balancers and container orchestrators for readiness checks.

A Prometheus metrics endpoint exposes counters for payments created, succeeded, and failed; counters for provider requests, timeouts, idempotency replays, and conflicts; and a histogram for payment processing duration. These metrics are sufficient to build alerting on failure rate spikes, timeout rate increases, and processing latency degradation.

All log events are structured JSON with a timestamp, level, message, and relevant context fields such as payment ID, status, and provider request ID. Phone numbers and full request payloads are not logged.

---

## Scalability

### What scales horizontally today

Multiple API replicas can run without coordination because the advisory lock and unique constraint live in the shared database. All replicas enforce the same idempotency guarantee. Multiple worker replicas can run in parallel because `FOR UPDATE SKIP LOCKED` ensures each outbox record is claimed by exactly one worker at a time.

### Current bottlenecks

Each payment creation holds a serializable transaction and an advisory lock for the duration of the idempotency check. Under very high concurrency on the same `(organisation_id, idempotency_key)` pair this serialises requests, which is the correct behaviour but does limit throughput for that specific key. In practice, the same key is rarely submitted concurrently more than a handful of times.

The outbox worker polls on a fixed interval. Under high volume, additional worker instances can be started — each will pick up a different record. The poll interval can be tuned via the `OUTBOX_POLL_MS` environment variable.

### Production improvements

See [TECHNICAL_NOTE.md](TECHNICAL_NOTE.md) for a full list. Key items include a reconciliation job for payments stuck in `PROCESSING` beyond a threshold, a circuit breaker around the provider client, idempotency key expiry, distributed tracing, and an external message queue as an alternative to the database-backed outbox for higher throughput workloads.
